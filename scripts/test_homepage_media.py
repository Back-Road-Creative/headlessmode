"""Contract test for the homepage's per-product picture.

Every product row on the storefront homepage shows one picture. On each
tier="product" entry that the homepage lists (homepage is not false),
data/systems.json carries `homepage_image`: a path relative to `/img/` naming
a file that must already exist with real provenance in that product's
static/img/<slug>/manifest.json (scripts/test_media_manifest.py owns that
provenance rule; this file only checks the homepage wiring on top of it).
`homepage_image_alt` is required alongside it — no image without alt text —
and `homepage_image_width`/`homepage_image_height` match the manifest viewport
so the row reserves the right space before the picture loads.

Reads public/, like scripts/test_chip_readiness.py, so it runs AFTER the
Hugo build.

Run: bash scripts/build-site.sh --configDir site-config --minify && pytest scripts/test_homepage_media.py -v
"""

import json
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
PUBLIC = ROOT / "public"
SYSTEMS = ROOT / "data" / "systems.json"
IMG_ROOT = ROOT / "static" / "img"


def _systems() -> list[dict]:
    data = json.loads(SYSTEMS.read_text(encoding="utf-8"))
    return data["systems"]


def _products_with_homepage_image() -> list[dict]:
    return [s for s in _systems() if s.get("homepage_image")]


class _Imgs(HTMLParser):
    """Every <img> on a built page, as its attribute dict.

    Parsed rather than pattern-matched. Production builds with --minify, which
    drops the quotes from single-token attributes (src=/img/x.png loading=lazy),
    so a pattern written against src="..." matches the unminified build and
    nothing PR CI or the deploy ships (see test_systems_contract.py's _Roster).
    """

    def __init__(self) -> None:
        super().__init__()
        self.imgs: list[dict[str, str | None]] = []

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.imgs.append(dict(attrs))


def _homepage_imgs() -> list[dict[str, str | None]]:
    parser = _Imgs()
    parser.feed(_homepage_html())
    return parser.imgs


def _homepage_html() -> str:
    if not PUBLIC.exists():
        pytest.fail("public/ does not exist — run: bash scripts/build-site.sh --configDir site-config --minify")
    path = PUBLIC / "index.html"
    assert path.exists(), f"expected a built page at {path}"
    return path.read_text(encoding="utf-8")


def test_homepage_image_key_is_on_homepage_entries_only() -> None:
    """A product, or a free tool opted onto the homepage with "homepage": true."""
    for sys in _products_with_homepage_image():
        listed = sys["tier"] == "product" or (sys["tier"] == "oss" and sys.get("homepage") is True)
        assert listed, (
            f"{sys['name']} sets homepage_image but tier is {sys['tier']!r} and it is "
            "not opted onto the homepage — the row pictures are a homepage feature"
        )


def test_homepage_image_requires_alt_text() -> None:
    for sys in _products_with_homepage_image():
        alt = sys.get("homepage_image_alt", "")
        assert alt and alt.strip(), (
            f"{sys['name']} sets homepage_image with no non-empty homepage_image_alt"
        )


def test_homepage_image_file_exists_with_manifest_provenance() -> None:
    for sys in _products_with_homepage_image():
        rel = sys["homepage_image"]
        img_path = IMG_ROOT / rel
        assert img_path.exists(), (
            f"{sys['name']}'s homepage_image {rel!r} does not exist under static/img/"
        )
        slug, filename = rel.split("/", 1)
        manifest_path = IMG_ROOT / slug / "manifest.json"
        assert manifest_path.exists(), (
            f"{sys['name']}'s homepage_image {rel!r} has no static/img/{slug}/manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert filename in manifest["images"], (
            f"{sys['name']}'s homepage_image {rel!r} has no entry in "
            f"static/img/{slug}/manifest.json"
        )


def test_homepage_image_dimensions_match_manifest_viewport() -> None:
    for sys in _products_with_homepage_image():
        rel = sys["homepage_image"]
        slug, filename = rel.split("/", 1)
        manifest = json.loads((IMG_ROOT / slug / "manifest.json").read_text(encoding="utf-8"))
        viewport = manifest["images"][filename]["viewport"]
        want_w, want_h = (int(n) for n in viewport.split("x"))
        assert sys.get("homepage_image_width") == want_w, (
            f"{sys['name']}'s homepage_image_width does not match manifest viewport {viewport!r}"
        )
        assert sys.get("homepage_image_height") == want_h, (
            f"{sys['name']}'s homepage_image_height does not match manifest viewport {viewport!r}"
        )


def _homepage_products() -> list[dict]:
    return [s for s in _systems() if s["tier"] == "product" and s.get("homepage", True) is not False]


def test_every_homepage_product_declares_a_homepage_image() -> None:
    missing = [s["name"] for s in _homepage_products() if not s.get("homepage_image")]
    assert not missing, f"homepage products with no homepage_image: {missing}"


def test_homepage_renders_each_product_image_with_its_alt_and_size() -> None:
    rendered = {i.get("src"): i for i in _homepage_imgs()}
    for sys in _homepage_products():
        src = f"/img/{sys['homepage_image']}"
        assert src in rendered, f"homepage does not render {sys['name']}'s picture {src}"
        img = rendered[src]
        assert img.get("alt") == sys["homepage_image_alt"], f"{sys['name']}'s picture alt differs"
        assert img.get("width") == str(sys["homepage_image_width"])
        assert img.get("height") == str(sys["homepage_image_height"])
