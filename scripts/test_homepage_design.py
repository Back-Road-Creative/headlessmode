"""Contract test for the homepage: forest hero, picture rows, one button each.

Reads public/ and the theme stylesheet, so it runs AFTER the Hugo build:
  bash scripts/build-site.sh --configDir site-config --minify && pytest scripts/test_homepage_design.py -v

Markup is parsed, not pattern-matched: production builds with --minify, which
drops quotes from single-token attributes.
"""

import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).parent.parent
HOME = ROOT / "public" / "index.html"
CSS = ROOT / "themes" / "headlessmode" / "static" / "css" / "style.css"
SYSTEMS = ROOT / "data" / "systems.json"

HERO_TITLE = "For the things we’re working on."
HERO_LEDE = "A collection of projects."
# The homepage's primary buttons. Every row also carries "Details →".
ACTION_LABELS = {"Download", "Open the map", "View demo", "Ask about Framegrade", "Installation"}
# Free = public (used directly, nothing to arrange) or a free tool; Preview = everything else.
CHIP_WORDING = {
    "Band Coach": "Free",
    "Quiet Corners": "Free",
    "rigscore": "Free",
    "bot-battle-station": "Free",
    "Waypost": "Preview",
    "Framegrade": "Preview",
}


class _Page(HTMLParser):
    """Stanzas (actions, chip, images), the masthead links and the hire band."""

    def __init__(self) -> None:
        super().__init__()
        self.classes_seen: set[str] = set()
        self.stanzas: list[dict] = []
        self.masthead_links: list[str] = []
        self.hire: list[list[str]] = []
        self.h1 = ""
        self.lede = ""
        self._stanza: dict | None = None
        self._depth = 0
        self._sink: tuple | None = None  # (container, key) receiving text
        self._in_masthead = False
        self._in_hire = False
        self._in_nav = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = set((a.get("class") or "").split())
        self.classes_seen |= cls
        if tag == "header" and "masthead" in cls:
            self._in_masthead = True
        if self._in_masthead and tag == "nav":
            self._in_nav = True
        if "hire-band" in cls:
            self._in_hire = True
        if self._stanza is not None and tag == "div":
            self._depth += 1
        if tag == "div" and "product-stanza" in cls and self._stanza is None:
            self._stanza = {"name": "", "actions": [], "details": [], "chip": "", "imgs": []}
            self._depth = 1
        elif self._stanza is not None:
            if tag == "img":
                self._stanza["imgs"].append(a)
            if "product-name" in cls:
                self._sink = (self._stanza, "name")
            if "shelf-panel__chip" in cls:
                self._sink = (self._stanza, "chip")
            if tag == "a" and cls & {"action-link", "btn-primary"}:
                action = {"text": "", "href": a.get("href")}
                self._stanza["actions"].append(action)
                self._sink = (action, "text")
            if tag == "a" and "details-link" in cls:
                link = {"text": "", "href": a.get("href")}
                self._stanza["details"].append(link)
                self._sink = (link, "text")
        if tag == "h1" and "hero-title" in cls:
            self._sink = (self, "h1")
        if tag == "p" and "hero-lede" in cls:
            self._sink = (self, "lede")
        if tag == "a" and self._in_nav:
            entry = {"text": ""}
            self.masthead_links.append(entry)
            self._sink = (entry, "text")
        if tag == "a" and self._in_hire:
            entry = {"text": "", "href": a.get("href") or ""}
            self.hire.append(entry)
            self._sink = (entry, "text")

    def handle_data(self, data):
        if self._sink is not None:
            container, key = self._sink
            if isinstance(container, dict):
                container[key] += data
            else:
                setattr(container, key, getattr(container, key) + data)

    def handle_endtag(self, tag):
        if tag in ("a", "span", "h3", "h1", "p"):
            self._sink = None
        if tag == "nav":
            self._in_nav = False
        if tag == "header":
            self._in_masthead = False
        if self._stanza is not None and tag == "div":
            self._depth -= 1
            if self._depth == 0:
                self.stanzas.append(self._stanza)
                self._stanza = None


def page() -> _Page:
    assert HOME.is_file(), "build the site first (public/index.html missing)"
    p = _Page()
    p.feed(HOME.read_text())
    return p


def css() -> str:
    return re.sub(r"/\*.*?\*/", "", CSS.read_text(), flags=re.S)


def rule(selector: str) -> str:
    """Declarations of every top-level rule whose selector list names `selector`."""
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css()):
        if selector in [s.strip() for s in m.group(1).split(",")]:
            out.append(m.group(2))
    return "\n".join(out)


def test_homepage_has_no_green_section_label_row():
    assert "section-label-row" not in page().classes_seen
    assert ".section-label-row" not in css()


def test_hero_states_the_headline_and_line_and_no_inventory_link():
    p = page()
    assert p.h1.strip() == HERO_TITLE
    assert p.lede.strip() == HERO_LEDE
    assert "hero-link" not in p.classes_seen
    assert "one-person studio" not in HOME.read_text()


def test_hero_is_a_forest_band_with_a_kelly_rule():
    assert "var(--forest)" in rule(".hero-band")
    assert "var(--kelly)" in rule(".hero-rule")
    assert "hero-rule" in page().classes_seen


def test_every_product_row_renders_and_grant_platform_is_off_the_homepage():
    assert [s["name"].strip() for s in page().stanzas] == list(CHIP_WORDING)
    assert "Grant Platform" not in HOME.read_text()


def test_each_row_has_one_allowed_button_and_a_details_link():
    bad = []
    for s in page().stanzas:
        labels = [x["text"].strip() for x in s["actions"]]
        if len(labels) != 1 or labels[0] not in ACTION_LABELS:
            bad.append(f"{s['name'].strip()}: {labels}")
        details = [(d["text"].strip(), d["href"]) for d in s["details"]]
        if len(details) != 1 or not details[0][0].startswith("Details"):
            bad.append(f"{s['name'].strip()}: details {details}")
    assert not bad, "; ".join(bad)


def test_the_planned_buttons():
    by = {s["name"].strip(): (s["actions"][0]["text"].strip(), s["actions"][0]["href"])
          for s in page().stanzas if s["actions"]}
    assert by["Band Coach"][0] == "Download"
    assert by["Quiet Corners"] == ("Open the map", "/quiet-corners/#dashboard")
    assert by["rigscore"] == ("Installation", "/rigscore/#install")
    assert by["Waypost"] == ("View demo", "/demo/waypost/")
    assert by["Framegrade"] == ("Ask about Framegrade", "/contact/")
    assert by["bot-battle-station"] == ("Installation", "/bot-battle-station/")


def test_stanza_tags_say_free_or_preview():
    got = {s["name"].strip(): s["chip"].strip() for s in page().stanzas}
    assert got == CHIP_WORDING


def test_tag_wording_follows_access():
    systems = {s["name"]: s for s in json.loads(SYSTEMS.read_text())["systems"]}
    for name, want in CHIP_WORDING.items():
        free = systems[name]["tier"] == "oss" or systems[name].get("access") == "public"
        assert ("Free" if free else "Preview") == want, name


def test_every_row_has_one_picture_with_alt_text_that_exists():
    for s in page().stanzas:
        imgs = s["imgs"]
        assert len(imgs) == 1, s["name"]
        img = imgs[0]
        assert (img.get("alt") or "").strip(), f"{s['name']}: no alt"
        assert img.get("width") and img.get("height"), f"{s['name']}: no intrinsic size"
        assert (ROOT / "static" / img["src"].lstrip("/")).is_file(), img["src"]


def test_contact_band_says_get_in_touch():
    links = [(h["href"], h["text"].strip()) for h in page().hire]
    assert ("/contact/", "Get in touch") in links, links


def test_masthead_has_exactly_about_and_contact():
    assert [t["text"].strip() for t in page().masthead_links] == ["About", "Contact"]


def test_details_link_is_a_44px_target():
    assert "min-height: 44px" in rule(".details-link")


def test_phone_hero_is_shorter():
    assert re.search(r"@media \(max-width: 600px\)\s*\{[^}]*\.hero\b", css())


def test_filled_controls_get_a_two_tone_focus_ring():
    for sel in (".btn-primary:focus-visible", ".try-cta:focus-visible"):
        decl = rule(sel)
        assert "box-shadow" in decl and "#fff" in decl, sel
        assert "var(--text-primary)" in decl, sel
        assert "--accent-600" not in decl, f"{sel} draws green on green"


def test_global_link_focus_ring_stays_green():
    assert "var(--accent-500)" in rule("a:focus-visible")


def test_action_link_is_green_underlined_and_44px_tall():
    decl = rule(".action-link")
    assert "var(--accent-500)" in decl
    assert "underline" in decl
    assert "min-height: 44px" in decl
    assert "var(--accent-600)" in rule(".action-link:hover")


def test_masthead_links_are_44px_tall():
    assert "min-height: 44px" in rule(".nav-link")


def test_masthead_is_forest_with_a_white_wordmark():
    """HM-A4: the masthead sits in the forest band, not on white."""
    assert "var(--forest)" in rule(".masthead")
    assert "color: #fff" in rule(".site-wordmark")


def test_headline_serif_is_self_hosted_source_serif_4():
    """Georgia is missing on Linux and Android, where the headline fell back to
    a heavy wide serif; the face ships from /fonts/ (CSP font-src 'self')."""
    faces = re.findall(r"@font-face\s*\{([^}]*)\}", css())
    assert faces and all("'Source Serif 4'" in f and "url(/fonts/source-serif-4/" in f for f in faces)
    for f in faces:
        src = re.search(r"url\((/fonts/[^)]+)\)", f).group(1)
        assert (ROOT / "themes" / "headlessmode" / "static" / src.lstrip("/")).is_file(), src
    assert "Source Serif 4" in (ROOT / "NOTICE").read_text()


def test_accent_is_forest_green_not_blue_green():
    accent = re.search(r"--accent-500:\s*(#[0-9a-fA-F]{6})", css()).group(1)
    r, g, b = (int(accent[i:i + 2], 16) for i in (1, 3, 5))
    assert g > r and g > b and b <= g * 0.6, accent


def _luminance(hex_colour: str) -> float:
    chans = []
    for i in (1, 3, 5):
        c = int(hex_colour[i:i + 2], 16) / 255
        chans.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = chans
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def test_accent_text_tokens_meet_aa_on_paper_and_white():
    """--accent-400 is used as text (the Quiet Corners trust panel); pa11y
    caught #2f8f4a at 4.08:1, so every accent text token is held to 4.5:1."""
    tokens = {}
    for k, v in re.findall(r"(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", css()):
        tokens.setdefault(k, v)  # :root comes first; later scopes are dark surfaces
    for name in ("--accent-400", "--accent-500", "--accent-600"):
        fg = _luminance(tokens[name])
        for bg_hex in (tokens["--bg-primary"], "#ffffff"):
            bg = _luminance(bg_hex)
            ratio = (max(fg, bg) + 0.05) / (min(fg, bg) + 0.05)
            assert ratio >= 4.5, f"{name} {tokens[name]} on {bg_hex}: {ratio:.2f}:1"


QC_FILES = [ROOT / "themes" / "headlessmode" / "static" / p for p in (
    "css/quiet-corners.css", "css/quiet-corners-maps.css", "css/quiet-corners-terrain.css",
    "js/quiet-corners.js", "js/quiet-corners-maps/main.js")]
EMERALD = ("#10b981", "#34d399", "#6ee7b7")


def _hue(hex_colour: str) -> float:
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    hi, lo = max(r, g, b), min(r, g, b)
    assert hi == g and hi > lo, hex_colour
    return 60 * (b - r) / (hi - lo) + 120


def test_quiet_corners_dark_accent_is_forest_not_mint():
    """The map tool's dark surface used Tailwind emerald (hue ~160, blue-green);
    its accents are forest (hue 125-140) and still read at 4.5:1 on its panels."""
    dark = re.search(r"\.themed-\\\[dark\\\]\s*\{([^}]*)\}", css()).group(1)
    tokens = dict(re.findall(r"(--accent-\d+):\s*(#[0-9a-fA-F]{6})", dark))
    assert set(tokens) == {"--accent-300", "--accent-400", "--accent-500"}
    for name, value in tokens.items():
        assert 125 <= _hue(value) <= 140, f"{name} {value}"
        fg = _luminance(value)
        for bg_hex in ("#09090b", "#0d0d1a", "#12121e", "#18181b"):
            bg = _luminance(bg_hex)
            assert (fg + 0.05) / (bg + 0.05) >= 4.5, f"{name} {value} on {bg_hex}"
    for f in QC_FILES:
        text = f.read_text().lower()
        assert not [c for c in EMERALD if c in text], f.name
