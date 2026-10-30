#!/usr/bin/env python3
"""Site-owned contract test: the three files that claim what this site holds,
checked against the pages Hugo actually built.

data/systems.json (the roster), site-config/_default/menus.toml (page data)
and static/llms.txt (what agents are told to read) each describe the site, and
nothing compared them to the build or to each other. systems.json had no reader
outside Hugo templates -- despite its own _contract claiming "CI probes every
link here" -- and llms.txt had no reader at all. So a system could point at a
deleted page, fall out of llms.txt, or promise a download that was never built
with CI green.

Hybrid redesign (2026-08-06): the roster renders exactly once, on the
homepage between the Boutique hero and hire band -- /systems/ and /releases/
are gone (static/_redirects 301s them). The truth assertions are unchanged
and retargeted at the homepage's product stanzas and tool rows
(themes/headlessmode/layouts/index.html), plus two structural ones: every
system page renders a Documentation section (downloads and documentation
live together on each system's own page), and the homepage carries the
id="software" anchor the nav and the retired-catalog redirects land on.
URLs may carry fragments now (/#software), so site_path() strips them
before resolving -- a fragment names a place ON a page, not a page.

Reads public/, so it runs AFTER the Hugo build (deploy workflow, "Validate -
Critical pages exist"). It fails rather than skips when public/ is missing: a
validation that passes on absent input is exactly the hole this file closes.

Run: hugo --configDir site-config --minify && pytest scripts/test_systems_contract.py -v
(--minify because that is what production ships; see _Roster on why it matters.)
"""

import json
import re
import subprocess
import tomllib
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
PUBLIC = ROOT / "public"
SYSTEMS = ROOT / "data" / "systems.json"
MENUS = ROOT / "site-config" / "_default" / "menus.toml"
LLMS = ROOT / "static" / "llms.txt"
QUIET_CORNERS_JS = (
    ROOT / "themes" / "headlessmode" / "static" / "js" / "quiet-corners.js"
)

# The tiers data/systems.json's own _contract defines and the homepage roster
# renders a section for (oss -> tool rows, product -> stanzas; case-study is
# reserved). A tier outside this set renders nowhere.
KNOWN_TIERS = {"oss", "product", "case-study"}

# The access values the _contract allows on a tier="product" entry: how the
# product is acquired (public -> self-serve in the browser, engagement ->
# through the studio via /contact/). Product-only; every other tier must omit
# the key entirely.
KNOWN_ACCESS = {"public", "engagement"}

SITE_HOST = re.compile(r"^https?://(www\.)?headlessmode\.com")
MD_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

# The built roster: the homepage, once. Class contract with
# themes/headlessmode/layouts/index.html (selectors only -- the assertions
# behind them are the card-era ones, retargeted).
HOMEPAGE = "/"
TOOL_ROW = "tool-row"
TOOL_NAME = "tool-row__name"
TOOL_ACTION = "tool-row__action"
TOOL_CMD = "tool-row__cmd"
TOOL_ACTIONS = "tool-row__actions"
TOOL_SOURCE = "tool-row__source"
STANZA = "product-stanza"
STANZA_NAME = "product-name"
STANZA_META = "product-meta"
CONTACT = "/contact/"  # the studio path every product page still carries
BUY_CTA = "try-cta"  # the buy box's primary action (partials/get-system.html)
CTA_SECONDARY = "cta-secondary"  # the buy box's secondary action, same partial

@dataclass
class _Tool:
    """One rendered tool row: its name (a link when the entry has one, plain
    text when it does not -- href stays None then), and its single get action
    -- a Download/GitHub link (action_*) or a literal install command (cmd)."""

    name: str = ""
    href: str | None = None
    action_text: str = ""
    action_href: str | None = None
    cmd: str = ""
    source_href: str | None = None
    actions_wrapped: bool = False


@dataclass
class _Product:
    """One rendered product stanza: its name link, the meta line's text
    (status wording) and every link the meta carries -- plus any get-action
    classes that leak in, which must stay empty (products offer no
    download/install on the roster)."""

    name: str = ""
    href: str | None = None
    meta_text: str = ""
    meta_hrefs: list = field(default_factory=list)
    stray_classes: set = field(default_factory=set)


class _Roster(HTMLParser):
    """Reads the homepage into ordered _Tool / _Product lists.

    Parsed rather than pattern-matched on purpose. Production builds with
    --minify, which drops the quotes from single-token attributes, so patterns
    written against class="..." matched the unminified build PR CI produced
    and nothing the deploy shipped -- four card-era tests passed on every PR
    and failed on every deploy. A parser reads attributes rather than
    punctuation, so quoting cannot break it again.
    """

    def __init__(self) -> None:
        super().__init__()
        self.tools: list[_Tool] = []
        self.products: list[_Product] = []
        self._tool: _Tool | None = None
        self._product: _Product | None = None
        self._div_depth = 0
        self._capture: str | None = None  # tool-name | action | cmd | product-name | meta

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        classes = set((attr.get("class") or "").split())
        if self._product is not None:
            if tag == "div":
                self._div_depth += 1
            self._product.stray_classes |= classes & {TOOL_ACTION, TOOL_CMD}
            if tag == "a" and self._capture == "product-name" and self._product.href is None:
                self._product.href = attr.get("href")
            elif tag == "h3" and STANZA_NAME in classes:
                self._capture = "product-name"
            elif tag == "p" and STANZA_META in classes:
                self._capture = "meta"
            elif tag == "a" and self._capture == "meta":
                self._product.meta_hrefs.append(attr.get("href"))
            return
        if self._tool is not None:
            if TOOL_ACTIONS in classes:
                self._tool.actions_wrapped = True
            if tag in ("a", "span") and TOOL_NAME in classes:
                self._tool.href = attr.get("href")
                self._capture = "tool-name"
            elif tag == "a" and (TOOL_ACTION in classes or TOOL_SOURCE in classes):
                if TOOL_ACTION in classes:
                    self._tool.action_href = attr.get("href")
                    self._capture = "action"
                if TOOL_SOURCE in classes:
                    self._tool.source_href = attr.get("href")
            elif tag == "code" and TOOL_CMD in classes:
                self._capture = "cmd"
            return
        if tag == "p" and TOOL_ROW in classes:
            self._tool = _Tool()
        elif tag == "div" and STANZA in classes:
            self._product = _Product()
            self._div_depth = 1

    def handle_endtag(self, tag):
        if self._product is not None:
            if tag in ("h3", "p"):
                self._capture = None
            if tag == "div":
                self._div_depth -= 1
                if self._div_depth == 0:
                    self._product.name = self._product.name.strip()
                    self.products.append(self._product)
                    self._product = None
            return
        if self._tool is not None:
            if tag in ("a", "code", "span"):
                self._capture = None
            elif tag == "p":
                self._tool.name = self._tool.name.strip()
                self.tools.append(self._tool)
                self._tool = None

    def handle_data(self, data):
        if self._product is not None:
            if self._capture == "product-name":
                self._product.name += data
            elif self._capture == "meta":
                self._product.meta_text += data
            return
        if self._tool is not None:
            if self._capture == "tool-name":
                self._tool.name += data
            elif self._capture == "action":
                self._tool.action_text += data
            elif self._capture == "cmd":
                self._tool.cmd += data


class _Anchors(HTMLParser):
    """Every <a> on a built page, as (classes, href). Attributes are read, not
    pattern-matched -- _Roster's reason: --minify drops attribute quotes."""

    def __init__(self) -> None:
        super().__init__()
        self.anchors: list[tuple[set, str | None]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        attr = dict(attrs)
        self.anchors.append((set((attr.get("class") or "").split()), attr.get("href")))


def systems():
    return json.loads(SYSTEMS.read_text())["systems"]


def home_products():
    """Entries the homepage shows: tier product unless "homepage": false, and a
    free tool only when it opts in with "homepage": true."""
    return [
        s for s in systems()
        if (s["tier"] == "product" and s.get("homepage", True))
        or (s["tier"] == "oss" and s.get("homepage") is True)
    ]


def llms_links():
    return MD_LINK.findall(LLMS.read_text())


def site_path(url: str) -> str | None:
    """The site-relative path a URL points at, or None when it is off-site.

    Fragments are stripped: /#software resolves to the homepage, and whether
    the anchor itself exists is a separate assertion
    (test_the_software_anchor_exists_on_the_homepage) -- built() maps paths
    to files, and a fragment is not part of the file path."""
    if SITE_HOST.match(url):
        url = SITE_HOST.sub("", url) or "/"
    elif url.startswith(("http://", "https://")):
        return None
    url = url.split("#", 1)[0] or "/"
    return url if url.startswith("/") else None


def built(path: str) -> Path:
    """Where Hugo writes a site path (pretty URLs; the site sets no uglyURLs)."""
    rel = path.strip("/")
    if not rel:
        return PUBLIC / "index.html"
    target = PUBLIC / rel
    return target if target.suffix else target / "index.html"


def page_anchors(path: str) -> list:
    """Every anchor Hugo built at a site path, as (classes, href)."""
    page = built(path)
    assert page.is_file(), f"missing {page.relative_to(ROOT)} -- build the site first"
    parser = _Anchors()
    parser.feed(page.read_text())
    return parser.anchors


def rendered_roster() -> _Roster:
    """The tool rows and product stanzas Hugo built on the homepage."""
    page = built(HOMEPAGE)
    assert page.is_file(), f"missing {page.relative_to(ROOT)} -- build the site first"
    roster = _Roster()
    roster.feed(page.read_text())
    assert all(t.name for t in roster.tools), "a tool row renders no name"
    assert all(p.name for p in roster.products), "a product stanza renders no name"
    return roster


def test_the_build_is_present():
    assert PUBLIC.is_dir(), (
        f"{PUBLIC} does not exist -- build the site before this test. Failing "
        "rather than skipping is deliberate."
    )


@pytest.mark.parametrize("page", ["/", "/404.html"])
def test_the_pages_every_deploy_needs_are_built(page):
    assert built(page).is_file(), f"missing {built(page).relative_to(ROOT)}"


def test_every_main_menu_entry_resolves_to_a_built_page():
    menu = tomllib.loads(MENUS.read_text())["main"]
    missing = [
        f"{e['name']} -> {e['url']}"
        for e in menu
        if (p := site_path(e["url"])) and not built(p).is_file()
    ]
    assert not missing, "nav entries with no built page: " + "; ".join(missing)


def test_the_wordmark_is_the_only_home_destination_in_the_primary_nav():
    """The wordmark already leads home, so the menu stays focused on the two
    other site destinations instead of adding a second home-page link."""
    menu = tomllib.loads(MENUS.read_text())["main"]
    assert [(entry["name"], entry["url"]) for entry in menu] == [
        ("About", "/about/"),
        ("Contact", "/contact/"),
    ]


def test_the_retired_catalog_pages_are_not_built():
    """/systems/, /docs/ and /releases/ are 301s now (static/_redirects). A
    build that starts emitting them again would put the roster on two
    surfaces, resurrect the hub, or bring back the release section whose
    notes moved to GitHub -- redirect and page would fight, with the page
    winning silently."""
    for path in ("/systems/", "/docs/", "/releases/"):
        assert not built(path).is_file(), (
            f"{path} is built again -- the hybrid redesign 301s it; "
            "remove the page or remove the redirect, not both"
        )


class _Ids(HTMLParser):
    """Collects the id of every element on a page."""

    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()

    def handle_starttag(self, tag, attrs):
        element_id = dict(attrs).get("id")
        if element_id:
            self.ids.add(element_id)


def test_the_software_anchor_exists_on_the_homepage():
    """Static redirects, direct links and llms.txt land on /#software.
    site_path() strips the fragment when
    resolving pages, so nothing else would notice the anchor itself
    disappearing -- this does."""
    page = built(HOMEPAGE)
    assert page.is_file(), f"missing {page.relative_to(ROOT)} -- build the site first"
    ids = _Ids()
    ids.feed(page.read_text())
    assert "software" in ids.ids, (
        'the homepage renders no id="software" element -- /systems/ redirects, '
        "direct links and llms.txt all point at /#software"
    )


def test_every_system_link_resolves_to_a_built_page():
    missing = [
        f"{s['name']} -> {s['link']}"
        for s in systems()
        if "link" in s and (p := site_path(s["link"])) and not built(p).is_file()
    ]
    assert not missing, (
        "data/systems.json links with no built page: " + "; ".join(missing)
    )


def test_every_tier_is_one_the_roster_renders():
    bad = [
        f"{s.get('name', '<unnamed>')}: {s.get('tier')!r}"
        for s in systems()
        if s.get("tier") not in KNOWN_TIERS
    ]
    assert not bad, f"tiers outside {sorted(KNOWN_TIERS)}: " + "; ".join(bad)


def test_every_product_declares_its_access_and_nothing_else_does():
    """The _contract's access rule: every tier="product" entry says how it is
    acquired (one of KNOWN_ACCESS) so presentation can derive the acquisition
    path from data, and no other tier carries the key — no template reads it
    there, so it could only mislead the next edit."""
    bad = []
    for s in systems():
        if s.get("tier") == "product":
            if s.get("access") not in KNOWN_ACCESS:
                bad.append(f"{s.get('name', '<unnamed>')}: access={s.get('access')!r}")
        elif "access" in s:
            bad.append(f"{s.get('name', '<unnamed>')}: tier={s.get('tier')!r} carries access")
    assert not bad, (
        f"access outside the _contract (products only, one of {sorted(KNOWN_ACCESS)}): "
        + "; ".join(bad)
    )


def test_every_system_carries_the_keys_the_roster_needs():
    missing = [
        f"{s.get('name', '<unnamed>')}.{key}"
        for s in systems()
        for key in ("name", "tier", "blurb", "shipped")
        if key not in s
    ]
    assert not missing, "systems.json entries missing keys: " + "; ".join(missing)


def test_every_llms_txt_site_link_resolves_to_a_built_page():
    missing = [
        f"{text} -> {url}"
        for text, url in llms_links()
        if (p := site_path(url)) and not built(p).is_file()
    ]
    assert not missing, "llms.txt links with no built page: " + "; ".join(missing)


def test_llms_txt_names_every_system_that_has_somewhere_to_point():
    """A system with a link is something an agent can go read, so the file that
    tells agents what is here has to list it. Link-less entries are exempt."""
    listed = {text.strip().lower() for text, _ in llms_links()}
    missing = [
        s["name"] for s in systems() if "link" in s and s["name"].lower() not in listed
    ]
    assert not missing, (
        "systems.json entries absent from static/llms.txt: " + ", ".join(missing)
    )


def test_llms_txt_lists_no_system_the_ledger_has_dropped():
    """The reverse direction: only these two sections enumerate systems, so a
    name here that systems.json no longer carries means one file was edited
    alone."""
    known = {s["name"].lower() for s in systems()}
    sections = re.findall(
        r"^## (?:Open source|Products)\n(.*?)(?=^## |\Z)",
        LLMS.read_text(),
        re.S | re.M,
    )
    stray = [
        text
        for section in sections
        for text, _ in MD_LINK.findall(section)
        if text.lower() not in known
    ]
    assert not stray, (
        "llms.txt names systems absent from data/systems.json: " + ", ".join(stray)
    )


# The two shapes themes/headlessmode/layouts/index.html emits for a tool row
# name, spelled the way production's --minify build writes them (single-token
# attributes lose their quotes): an <a> when the entry carries a "link", a
# <span> when it does not, because the template refuses to emit an anchor to
# nowhere. Synthetic rows -- push-guard exercises the link-less shape in the
# real ledger now, but the fixture stays: it pins the parser to both shapes
# whatever the data holds, so the day that entry gains a page of its own this
# coverage does not silently lapse with it.
TOOL_ROW_SHAPES = (
    "<p class=tool-row><a class=tool-row__name href=/linked-tool/>linked-tool</a>\n"
    "<span class=tool-row__dash aria-hidden=true>&mdash;</span>\n"
    "<span class=tool-row__blurb>Does one job</span>\n"
    "<span class=tool-row__dash aria-hidden=true>&mdash;</span>\n"
    "<a class=tool-row__action href=https://example.invalid/releases/latest "
    'aria-label="Download linked-tool" target=_blank rel="noopener noreferrer"'
    ">Download</a></p>\n"
    "<p class=tool-row><span class=tool-row__name>linkless-tool</span>\n"
    "<span class=tool-row__dash aria-hidden=true>&mdash;</span>\n"
    "<span class=tool-row__blurb>Does one job too</span>\n"
    "<span class=tool-row__dash aria-hidden=true>&mdash;</span>\n"
    "<code class=tool-row__cmd>pip install linkless-tool</code></p>"
)


def test_the_parser_reads_a_link_less_tool_row():
    """A link-less tool row must still yield its name.

    It renders <span class="tool-row__name"> rather than an <a>, and a parser
    that only starts capturing on <a> sees no name at all -- which does not
    fail as one clear miss but as rendered_roster()'s "a tool row renders no
    name", taking every roster assertion below with it, including the two
    product-stanza tests that have nothing to do with tools.

    Both halves are asserted here. Starting the capture on <span> is one; the
    other is ending it at that span's close, because the dash and blurb spans
    that follow otherwise append into the name and the roster reports a
    corrupted string instead of a clean failure."""
    roster = _Roster()
    roster.feed(TOOL_ROW_SHAPES)
    assert [t.name for t in roster.tools] == ["linked-tool", "linkless-tool"], (
        "the parser lost or corrupted a tool row name: "
        f"{[t.name for t in roster.tools]}"
    )
    linked, linkless = roster.tools
    assert linked.href == "/linked-tool/"
    assert linkless.href is None, "a link-less row must not report an href"
    assert linked.action_text.strip() == "Download"
    assert linkless.cmd.strip() == "pip install linkless-tool"


def test_the_homepage_roster_lists_every_product_exactly_once_and_no_tool():
    """The storefront contract: the homepage lists the products, once each,
    and from the open-source tier only a tool opted in with "homepage": true
    (rigscore) -- the other free tools live on their own pages and in
    llms.txt, not on the front window. A product marked "homepage": false
    keeps its page and is left off."""
    roster = rendered_roster()
    products = sorted(s["name"] for s in home_products())
    assert sorted(p.name for p in roster.products) == products, (
        "homepage does not list every product exactly once: "
        f"rendered {sorted(p.name for p in roster.products)}"
    )
    assert roster.tools == [], (
        "the homepage renders tool rows: " + ", ".join(t.name for t in roster.tools)
    )
    homepage = built(HOMEPAGE).read_text()
    leaked = [
        s["name"]
        for s in systems()
        if s["tier"] == "oss" and s.get("homepage") is not True and f">{s['name']}</a>" in homepage
    ]
    assert not leaked, "oss systems linked from the homepage: " + ", ".join(leaked)


def test_the_homepage_hero_does_not_repeat_a_featured_system():
    """The roster is already the catalog. A second flagship rendering above
    it consumes the first mobile screen and repeats the newest product."""
    homepage = built(HOMEPAGE).read_text()
    assert "hero-box" not in homepage


def test_the_homepage_has_no_free_tools_inventory_or_crosslinks():
    homepage = built(HOMEPAGE).read_text()
    for needle in ("Browse software", "hero-cta", ">Free tools</h2>", "roster-crosslink",
                   "roster-note", "SmartScreen", "tool-row"):
        assert needle not in homepage, f"homepage still carries {needle!r}"
    ids = _Ids()
    ids.feed(homepage)
    assert "tools" not in ids.ids, 'homepage still has id="tools"'
    installs = [s["install"] for s in systems() if s.get("install")]
    assert installs
    shown = [i for i in installs if i in homepage]
    assert not shown, "homepage shows install commands: " + "; ".join(shown)
    assert "product-thumb" not in homepage


def test_the_hero_states_the_headline_and_keeps_the_roster_anchors():
    homepage = built(HOMEPAGE).read_text()
    assert "For the things we’re working on." in homepage
    assert "one-person studio" not in homepage
    ids = _Ids()
    ids.feed(homepage)
    assert "products" in ids.ids and "software" in ids.ids


def test_the_contract_documents_homepage_rank():
    data = json.loads((ROOT / "data" / "systems.json").read_text())
    for key in ("homepage_rank", "homepage", "homepage_image", "homepage_action", "homepage_area"):
        assert key in data["_contract"], key


def test_every_homepage_product_has_a_picture_and_no_hidden_one_carries_homepage_keys():
    wrong = []
    shown = {s["name"] for s in home_products()}
    for s in systems():
        if s["tier"] not in ("product", "oss"):
            continue
        if s["name"] in shown:
            img = s.get("homepage_image") or ""
            if not s.get("homepage_image_alt") or not img or not (ROOT / "static" / "img" / img).is_file():
                wrong.append(f"{s['name']}: homepage_image {img!r}")
        elif {"homepage_rank", "homepage_image", "homepage_image_alt", "homepage_action", "homepage_area"} & set(s):
            wrong.append(f"{s['name']}: off the homepage but carries homepage keys")
    assert not wrong, "; ".join(wrong)


def test_the_hire_band_directly_follows_the_products():
    homepage = built(HOMEPAGE).read_text()
    last_product = homepage.rindex("product-stanza")
    assert homepage.index("hire-band") > last_product
    assert "tool-row" not in homepage[last_product:homepage.index("hire-band")]


def test_homepage_blurbs_are_the_canonical_plain_language_copy():
    """The same ledger blurb renders on the homepage and each system sheet,
    so these end-user descriptions are one factual source rather than two
    independently drifting taglines."""
    expected = {
        "Driftless": "Project, program and portfolio management where status, schedules and earned value are calculated from the work you record, so nobody types in a percent complete",
        "Quiet Corners": "Scores rural U.S. counties on stability, remoteness, sprawl risk and affordability using Census and USDA data, and prints true-scale field maps of any area you draw",
        "Grant Platform": "Runs grant work end to end on one platform — funder award administration and compliance, and recipient discovery, applications, reporting and closeout",
        "agent-audit": "Audits the configuration you give an AI coding agent: skill and instruction files, and workflow maturity",
        "claude-batch-runner": "Runs batches of Claude Code tasks from a spec, validates outputs and reports cost",
        "bot-battle-station": "A live wall screen for every Claude Code session on your machine: which need you, which are working, which wait on a job",
        "keycut": "Cuts and joins multiple video ranges, copying video by default and moving each start forward to the next keyframe",
        "pycube-lut": "Applies .cube LUTs, HALD CLUTs and 1D tone curves to NumPy images",
        "redactcam": "Blurs faces, license plates and vehicle cabins in video, and checks cabin masks against a second detection pass before encoding",
        "sun-track": "Calculates solar elevation and golden-hour windows, and matches capture times to positions in GPX tracks",
        "rigscore": "Checks an AI development setup's configuration for security, consistency and governance problems",
        "push-guard": "A client-side hook that blocks direct pushes to protected branches so changes go through pull requests",
        "Band Coach": "A practice coach for 27 instruments that listens through your microphone or MIDI keyboard, checks pitch and timing, and picks what to practice next",
        "Waypost": "A console on your own computer that runs a creator's video, photo and SEO work and queues posts for YouTube, Instagram and Facebook, one tab per brand",
        "Framegrade": "The media engine under Waypost: it grades video and photos, checks each finished file before delivery, and builds route films from GPS tracks",
    }
    assert {s["name"]: s["blurb"] for s in systems()} == expected


def _llms_line(name):
    lines = [l for l in LLMS.read_text().splitlines() if l.startswith(f"- [{name}]")]
    assert len(lines) == 1, f"expected one llms.txt line for {name}"
    return lines[0]


def test_llms_rigscore_scopes_online_and_semantic_checks_to_their_flags():
    """content/rigscore.md: a default scan is local; --online and --semantic
    are the opt-in exceptions. The llms.txt line must not read as if the
    scan always probes sites or judges tool descriptions."""
    line = _llms_line("rigscore")
    assert "--online" in line and "--semantic" in line


def test_keycut_never_says_lossless_without_a_keyframe_qualifier():
    """keycut copies video only from a keyframe and can re-encode a range,
    so an unqualified 'lossless' overclaims."""
    texts = [LLMS.read_text()] + [s["blurb"] for s in systems() if s["name"] == "keycut"]
    for text in texts:
        for m in re.finditer(r"[^.\n]*lossless[^.\n]*", text, re.I):
            assert "keyframe" in m.group(0).lower(), m.group(0)
    assert "keyframe" in _llms_line("keycut").lower()
    assert "lossless" not in _llms_line("keycut").lower()


def test_llms_waypost_says_tiktok_is_a_manual_handoff():
    """content/waypost.md: TikTok is unaudited, so Waypost writes the video
    and caption to a folder and the owner schedules it in TikTok Studio."""
    line = _llms_line("Waypost")
    assert re.search(r"TikTok[^.;]*manual", line)
    assert "Framegrade" in line
    assert "published slot on YouTube, TikTok," not in line


def test_llms_quiet_corners_links_its_public_repository():
    """github.com/Back-Road-Creative/quiet-corners is public, so llms.txt must
    link it the way the other open entries do ("Source: github.com/...") and
    must not claim there is nothing to link. Grant Platform's source stays
    private, and the Products paragraph must keep saying so."""
    text = LLMS.read_text()
    assert "Source: github.com/Back-Road-Creative/quiet-corners." in _llms_line("Quiet Corners")
    assert "no repository" not in text.lower()
    assert "Grant Platform's source is private" in text


PUBLIC_PRODUCTS = {
    "Waypost": ("waypost", "MIT"),
    "Framegrade": ("framegrade", "Apache-2.0"),
}


@pytest.mark.parametrize("name", sorted(PUBLIC_PRODUCTS))
def test_llms_states_waypost_and_framegrade_source_is_public(name):
    """Both repositories are public (MIT and Apache-2.0), so llms.txt must say
    so with the repository URL and licence and must not call either private."""
    repo, spdx = PUBLIC_PRODUCTS[name]
    text = LLMS.read_text()
    assert f"Source: github.com/Back-Road-Creative/{repo}." in _llms_line(name)
    assert f"{name} is public under {spdx} at github.com/Back-Road-Creative/{repo}" in text
    assert f"{name}'s is public" not in text
    assert f"nor {name}'s" not in text


@pytest.mark.parametrize("name", sorted(PUBLIC_PRODUCTS))
def test_waypost_and_framegrade_entries_carry_their_public_repo(name):
    """Like Driftless, a public engagement product names its repository in
    data/systems.json (the system-docs shortcode and the sheet's source link
    read it); the link stays the on-site page."""
    repo, _ = PUBLIC_PRODUCTS[name]
    entry = next(s for s in json.loads(SYSTEMS.read_text())["systems"] if s["name"] == name)
    assert entry["repo"] == f"https://github.com/Back-Road-Creative/{repo}"
    assert entry["link"] == f"/{repo}/"
    assert entry["access"] == "engagement" and entry["shipped"] is None
    rec = json.loads((ROOT / "data" / "releases" / f"{repo}.json").read_text())
    assert rec["source_repo"] == f"Back-Road-Creative/{repo}"
    assert "no product repository" not in rec["notes"]


@pytest.mark.parametrize("name", sorted(PUBLIC_PRODUCTS))
def test_waypost_and_framegrade_pages_state_public_source_and_licence(name):
    """The Access note names the public source, URL and licence while keeping
    the source-package / studio-engagement distinction; the
    Documentation section points at the repository README."""
    repo, spdx = PUBLIC_PRODUCTS[name]
    text = (ROOT / "content" / f"{repo}.md").read_text()
    access = text.split("> **Access.**", 1)[1].split("\n\n", 1)[0]
    flat = re.sub(r"\s+(?:>\s*)?", " ", access)
    assert f"The source is public under {spdx}" in flat
    assert f"https://github.com/Back-Road-Creative/{repo}" in flat
    assert "no installer or versioned release" not in flat
    assert "source package" in flat and "Release details" in flat
    assert "studio engagement" in flat
    assert "source is private" not in text
    assert "documentation are private" not in text
    docs = text.split("\n## Documentation\n", 1)[1]
    assert f'{{{{< system-docs name="{name}" >}}}}' in docs


def test_verify_claims_re_verifies_waypost_and_framegrade_licences():
    """The drift sentinel must re-check the licence each page now asserts."""
    src = (ROOT / "scripts" / "verify-claims.js").read_text()
    for name, (repo, spdx) in PUBLIC_PRODUCTS.items():
        assert (
            f"page: 'content/{repo}.md', owner: 'Back-Road-Creative', repo: '{repo}', spdx: '{spdx}'"
            in src
        )


def _ledger_order(entries):
    """The ledger's fallback sort, recomputed independently of the template:
    shipped entries first (newest month first, ties by name ascending
    case-insensitive), then every still-building entry in that same name
    order -- the two-pass stable sort index.html uses for unranked entries."""
    live = sorted((s for s in entries if s["shipped"]), key=lambda s: s["name"].lower())
    live = sorted(live, key=lambda s: s["shipped"], reverse=True)
    building = sorted((s for s in entries if not s["shipped"]), key=lambda s: s["name"].lower())
    return [s["name"] for s in live + building]


def _homepage_order(entries):
    """Ranked entries by homepage_rank ascending, then unranked in ledger order."""
    ranked = sorted((s for s in entries if "homepage_rank" in s), key=lambda s: s["homepage_rank"])
    return [s["name"] for s in ranked] + _ledger_order(
        [s for s in entries if "homepage_rank" not in s]
    )


def test_the_roster_order_is_deterministic():
    """index.html's documented order, recomputed independently of the
    template: homepage_rank ascending, unranked products after in the ledger
    rule (see _ledger_order)."""
    data = systems()
    roster = rendered_roster()
    assert [p.name for p in roster.products] == _homepage_order(home_products())


def test_the_products_are_ranked_in_the_storefront_order():
    ranks = {s["name"]: s.get("homepage_rank") for s in home_products()}
    assert ranks == {
        "Band Coach": 1, "Quiet Corners": 2, "rigscore": 3, "bot-battle-station": 4, "Waypost": 5, "Framegrade": 6,
    }
    assert [p.name for p in rendered_roster().products] == [
        "Band Coach", "Quiet Corners", "rigscore", "bot-battle-station", "Waypost", "Framegrade",
    ]


def test_driftless_is_not_advertised_on_the_homepage():
    """The owner, 2026-10-19: Driftless is not ready, so it is not advertised. Its page
    stays reachable by direct URL; the homepage neither lists nor links it."""
    driftless = next(s for s in systems() if s["name"] == "Driftless")
    assert driftless.get("homepage") is False
    assert "/driftless/" not in built(HOMEPAGE).read_text()


def test_every_homepage_product_shows_its_area_label():
    homepage = built(HOMEPAGE).read_text()
    want = {"Band Coach": "Music", "Quiet Corners": "Maps", "rigscore": "Code",
            "bot-battle-station": "Code", "Waypost": "Media", "Framegrade": "Media"}
    assert {s["name"]: s.get("homepage_area") for s in home_products()} == want
    assert homepage.count("product-area") == len(want)
    for area in set(want.values()):
        assert f">{area}</p>" in homepage, area


def test_product_stanzas_keep_status_and_source_detail_off_the_homepage():
    """A product stanza is a name, one sentence and one useful next step.
    Release history and source provenance belong on its detail page; the
    homepage does not repeat either or put Contact on every row."""
    stanzas = {p.name: p for p in rendered_roster().products}
    wrong = []
    for s in home_products():
        stanza = stanzas[s["name"]]
        if stanza.stray_classes:
            wrong.append(f"{s['name']}: renders get-action markup {sorted(stanza.stray_classes)}")
        if "Published" in stanza.meta_text or "source public" in stanza.meta_text:
            wrong.append(f"{s['name']}: verbose status remains: {stanza.meta_text.strip()!r}")
        if CONTACT in stanza.meta_hrefs and (s.get("homepage_action") or s["access"] == "public"):
            wrong.append(f"{s['name']}: repeats the global contact action")
        if s.get("repo") in stanza.meta_hrefs:
            wrong.append(f"{s['name']}: source link remains in homepage stanza")
    assert not wrong, "stanzas that disagree with the data: " + "; ".join(wrong)


def test_every_product_stanza_has_one_contextual_next_step():
    """One button, then Details to the product page. The button is the
    entry's homepage_action when set; otherwise a public product with a live
    download (download + shipped) downloads it, and an engagement product
    requests a demo through /contact/."""
    stanzas = {p.name: p for p in rendered_roster().products}
    missing = []
    for s in home_products():
        stanza = stanzas[s["name"]]
        if s.get("homepage_action"):
            want = s["homepage_action"]["href"]
        elif s["access"] == "public" and s.get("download") and s.get("shipped"):
            want = s["download"]
        else:
            want = CONTACT
        if stanza.meta_hrefs != [want, s["link"]]:
            missing.append(f"{s['name']}: expected [{want}, {s['link']}], got {stanza.meta_hrefs}")
    assert not missing, (
        "product stanzas with no acquisition path: " + "; ".join(missing)
    )


def test_homepage_does_not_repeat_the_about_page_positioning_copy():
    homepage = built(HOMEPAGE).read_text()
    assert "Headless Mode publishes the software" not in homepage


def test_contact_page_stays_focused_on_contact_channels():
    contact = built("/contact/").read_text()
    assert "Project inquiries" not in contact


def test_quiet_corners_renders_the_methodology_once():
    page = built("/quiet-corners/").read_text()
    assert page.count("The quiet corners of America") == 1


def test_quiet_corners_dashboard_keeps_one_clear_route_back_to_the_site():
    anchors = page_anchors("/quiet-corners/")
    assert any(
        "qc-site-return" in classes and href == "/" for classes, href in anchors
    )


def test_quiet_corners_dashboard_uses_the_page_scrollbar_only():
    page = built("/quiet-corners/").read_text()
    assert re.search(r"(?<!min-)h-screen", page) is None
    assert "overflow-y-auto" not in page
    assert "overflow-hidden" not in page


def test_quiet_corners_paginates_results_before_the_page_becomes_the_scrollbox():
    assert "const PAGE_SIZE = 10;" in QUIET_CORNERS_JS.read_text()


def test_quiet_corners_does_not_link_to_the_dashboard_immediately_below():
    page = built("/quiet-corners/").read_text()
    before_dashboard = page.split('id="dashboard"', 1)[0]
    assert "Explore the dashboard" not in before_dashboard


def test_every_engagement_product_page_offers_a_way_to_acquire_it():
    """The same invariant on the product sheet: a product's own page carries
    the buy box, and the box's primary CTA derives from the entry's "access".
    An engagement product leads with the studio path (try-cta -> /contact/).
    A public product is used directly in the browser, so its dashboard is the
    page content and needs no jump link immediately above itself. Scoped to
    the buy box's own CTA class rather than to any /contact/ link, which the
    footer puts on every page."""
    wrong = []
    for s in systems():
        if s["tier"] != "product" or not s.get("link"):
            continue
        path = site_path(s["link"])
        if path is None:
            continue
        anchors = page_anchors(path)
        if s["access"] == "engagement" and not any(
            BUY_CTA in cls and href == CONTACT for cls, href in anchors
        ):
            wrong.append(f"{s['name']}: no {BUY_CTA} -> {CONTACT}")
    assert not wrong, (
        "product pages whose buy box offers no acquisition path: " + "; ".join(wrong)
    )


def test_a_public_product_page_renders_the_dashboard_anchor():
    """The homepage links public products directly to #dashboard. The app
    wrapper on the product's own page must carry that target; site_path()
    strips fragments, so ordinary link resolution would not notice a miss.

    A public product with a live download (download + shipped) links to that
    download instead -- it is a one-click file, not a dashboard, and its page
    carries no #dashboard target to require."""
    missing = []
    for s in systems():
        if s["tier"] != "product" or s.get("access") != "public" or not s.get("link"):
            continue
        if s.get("download") and s.get("shipped"):
            continue
        path = site_path(s["link"])
        if path is None:
            continue
        page = built(path)
        assert page.is_file(), f"{s['name']}: {path} not built"
        ids = _Ids()
        ids.feed(page.read_text())
        if "dashboard" not in ids.ids:
            missing.append(f"{s['name']} ({path})")
    assert not missing, (
        'public product pages with no id="dashboard" target: ' + "; ".join(missing)
    )


def test_an_unshipped_system_keeps_its_title_link():
    """Carrying no ship month must not cost an entry its title link: the page
    an undated system already has stays reachable from its stanza."""
    stanzas = {p.name: p for p in rendered_roster().products}
    unlinked = [
        s["name"]
        for s in home_products()
        if not s["shipped"]
        and "link" in s
        and stanzas[s["name"]].href != s["link"]
    ]
    assert not unlinked, (
        "unshipped stanzas whose title lost its link: " + ", ".join(unlinked)
    )


# A direct-download "download" -- the exact GitHub Releases permalink form
# for one named asset off the LATEST release, never a pinned tag (a pinned
# asset rots the moment the next version ships, exactly like a hand-typed
# releases URL for someone else's repo).
DOWNLOAD_ASSET = re.compile(
    r"^(https://github\.com/[^/]+/[^/]+)/releases/latest/download/[^/]+$"
)

KNOWN_PLATFORMS = {"windows", "mac", "linux", "chromebook"}


def test_every_download_is_its_own_repo_s_latest_release():
    """Two failures this actually catches, both of which render as a perfectly
    normal-looking action: a download pointing at a DIFFERENT project's
    releases, and a pinned asset URL that rots the moment the next version
    ships. It cannot prove an installer exists -- only the release that built
    one can do that -- so the URL is at least forced to be derivable from the
    entry itself rather than typed freehand.

    "download" may be either the bare Releases page (an installer someone
    downloads and runs themselves) or a direct-asset permalink under that
    same repo's latest release (a single file fetched straight off
    releases/latest/download/<file> -- see DOWNLOAD_ASSET) -- both forms are
    pinned to the entry's own repo, never a pasted URL to somewhere else."""
    bad = []
    for s in systems():
        got = s.get("download")
        if not got:
            continue
        base = (s.get("repo") or s.get("link", "")).rstrip("/")
        releases_page = base + "/releases/latest"
        if got == releases_page:
            continue
        m = DOWNLOAD_ASSET.match(got)
        if m and m.group(1) == base:
            continue
        bad.append(
            f"{s['name']}: {got!r} should be {releases_page!r} or "
            f"{base}/releases/latest/download/<file>"
        )
    assert not bad, "download URLs that do not match the entry's own repo: " + "; ".join(bad)


def test_every_store_link_is_a_microsoft_store_url():
    """"store" names a Microsoft Store listing -- a web listing page or the
    ms-windows-store: protocol link that opens the Store app directly. Any
    other URL there could not possibly be either."""
    bad = [
        f"{s['name']}: {s['store']!r}"
        for s in systems()
        if s.get("store")
        and not (
            s["store"].startswith("https://apps.microsoft.com/")
            or s["store"].startswith("ms-windows-store://")
        )
    ]
    assert not bad, "store links that are not a Microsoft Store URL: " + "; ".join(bad)


def test_every_platforms_entry_is_one_the_roster_knows():
    """"platforms" drives which unsigned-installer note applies (see
    get-system.html) -- a value outside this set would silently fail to
    suppress that note rather than erroring."""
    bad = []
    for s in systems():
        plats = s.get("platforms")
        if plats is None:
            continue
        unknown = [p for p in plats if p not in KNOWN_PLATFORMS]
        if unknown:
            bad.append(f"{s['name']}: {unknown}")
    assert not bad, f"platforms outside {sorted(KNOWN_PLATFORMS)}: " + "; ".join(bad)


def test_every_system_page_renders_a_documentation_section():
    """Downloads and documentation live on ONE page per system: each on-site
    system page carries a #documentation anchor (on a heading or its section
    wrapper -- the dashboard page puts it on the <section>) -- rigscore's is
    the transcluded manual, the repo-documented tools state where their
    manual lives, Quiet Corners frames its methodology. The /docs/ hub is
    gone, so a system page without this anchor is a system with no
    documented docs location anywhere on the site."""
    missing = []
    for s in systems():
        path = site_path(s.get("link", "")) if "link" in s else None
        if not path:
            continue
        page = built(path)
        assert page.is_file(), f"{s['name']}: {path} not built"
        ids = _Ids()
        ids.feed(page.read_text())
        if "documentation" not in ids.ids:
            missing.append(f"{s['name']} ({path})")
    assert not missing, (
        "system pages with no Documentation section (no #documentation anchor): "
        + "; ".join(missing)
    )


def test_alias_stubs_are_titled_by_the_site_not_by_their_own_url():
    """Every `aliases:` stub renders layouts/alias.html, not Hugo's built-in.

    The built-in titles the stub with the raw permalink, so /cv/ shipped
    `<title>https://headlessmode.com/about/</title>` for a day. The override
    existed but sat at `layouts/_default/alias.html`: Hugo only added the alias
    template to the `_default/` lookup path in 0.146, and CI pins 0.139, so a
    local build on a newer Hugo rendered it while production silently did not.
    A wrong path is indistinguishable from a missing template at build time --
    Hugo falls back to the built-in without a warning -- so the only way to know
    is to read the rendered stub, which is what this does.
    """
    aliased = []
    for md in sorted((ROOT / "content").glob("*.md")):
        m = re.search(r"^aliases:\s*\[([^\]]*)\]", md.read_text(), re.MULTILINE)
        if m:
            aliased += [a.strip().strip("\"'") for a in m.group(1).split(",") if a.strip()]
    assert aliased, "no aliases found in content/ -- this test would pass vacuously"

    for alias in aliased:
        stub = built(alias)
        assert stub.is_file(), f"alias {alias} not built"
        title = re.search(r"<title>(.*?)</title>", stub.read_text(), re.DOTALL)
        assert title, f"alias {alias}: stub has no <title>"
        assert not title.group(1).strip().startswith("http"), (
            f"alias {alias}: title is the raw permalink ({title.group(1).strip()!r}), so "
            "Hugo used its built-in alias template. The override must be at "
            "layouts/alias.html -- layouts/_default/alias.html is ignored before Hugo 0.146."
        )


REDIRECTS = ROOT / "static" / "_redirects"


def _redirect_rules() -> list[tuple[str, str]]:
    """The (source, target) pairs in static/_redirects, comments and blanks out."""
    rules = []
    for line in REDIRECTS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            rules.append((parts[0], parts[1]))
    return rules


def _matches(pattern: str, path: str) -> bool:
    """Does a Cloudflare Pages _redirects source pattern match this path?

    The three forms this file uses: a literal, a trailing splat, and a
    `:placeholder` segment. The splat matches the EMPTY string, which is the
    whole point of this gate -- `/a/b/*` matches `/a/b/` as well as `/a/b/c`.
    A placeholder does not: it stands for exactly one non-empty segment, which
    is why naming the child is the fix for a splat that ate its parent."""
    splat = pattern.endswith("*")
    head = pattern[:-1] if splat else pattern
    if ":" not in head:
        return path.startswith(head) if splat else path == pattern

    want = [seg for seg in head.split("/") if seg != ""]
    got = [seg for seg in path.split("/") if seg != ""]
    if len(got) < len(want) or (not splat and len(got) != len(want)):
        return False
    return all(w.startswith(":") or w == g for w, g in zip(want, got))


def test_no_redirect_shadows_a_page_the_build_emits():
    """A rule whose source matches a page Hugo built takes that page off the
    site, and a rule pointing at its own source is an infinite 301.

    static/_redirects:76 `/quiet-corners/maps/* -> /quiet-corners/maps/ 301`
    shipped on 2026-09-07 (#420) to retire 51 per-state map pages. The splat
    matches the empty tail as well, so the one surviving map redirected to
    itself: `curl` reported 301 -> the same URL, five hops deep, and the Field
    Maps page was unreachable in production while every test here stayed green.
    The existing redirect assertions only check the reverse direction -- that a
    RETIRED path is not built again -- so nothing looked at a LIVE page being
    swallowed by a splat meant for its children."""
    pages = sorted(
        "/" + str(f.parent.relative_to(PUBLIC)).replace("\\", "/") + "/"
        for f in PUBLIC.rglob("index.html")
        if f.parent != PUBLIC
    )
    assert pages, "no built pages found -- build the site first"

    for source, target in _redirect_rules():
        for page in pages:
            if _matches(source, page):
                assert False, (
                    f"{source} -> {target} swallows the built page {page}. "
                    "A splat matches the empty tail, so a rule retiring a "
                    "page's children also retires the page itself; name the "
                    "child segment (/parent/:child) instead of splatting the "
                    "parent."
                )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


# ---- the product sheet band and the 404 ------------------------------------
# Contract with partials/system-sheet.html, partials/get-system.html and
# 404.html: the band opens with the name and one-line, the one primary action
# comes next (the buy box), and version/build provenance sits behind a
# <details> disclosure, stated once.

VOID_TAGS = {"br", "img", "input", "meta", "link", "hr", "source", "wbr"}


class _SheetBand(HTMLParser):
    """Walks the .sheet-band section in document order and records, for each
    piece of text and each action, whether it sits inside a <details>."""

    def __init__(self):
        super().__init__()
        self.depth = 0  # nesting depth inside the band; 0 = outside it
        self.in_details = 0
        self.in_buy = False
        self.events = []  # (kind, detail)
        self.text = []  # (text, inside_details)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "section" and "sheet-band" in classes:
            self.depth = 1
            self.events.append(("band", ""))
            return
        if not self.depth:
            return
        if tag not in VOID_TAGS:
            self.depth += 1
        if tag == "details":
            self.in_details += 1
            self.events.append(("details", ""))
        if "sheet-buy" in classes:
            self.in_buy = True
            self.events.append(("buy", ""))
        if "try-cta" in classes:
            self.events.append(("primary", a.get("href", "")))
        if tag == "code" and "install-cmd" in classes:
            self.events.append(("primary", "install-cmd"))
        if "cta-secondary" in classes:
            self.events.append(("secondary", a.get("href", "")))
        if tag == "h1":
            self.events.append(("h1", ""))

    def handle_endtag(self, tag):
        if not self.depth or tag in VOID_TAGS:
            return
        if tag == "details":
            self.in_details -= 1
        if tag == "aside":
            self.in_buy = False
        self.depth -= 1

    def handle_data(self, data):
        if self.depth and data.strip():
            self.text.append((data.strip(), bool(self.in_details)))


def _sheet_pages():
    """Every built page that renders the sheet band, as (site path, parsed band)."""
    out = []
    for page in sorted(PUBLIC.rglob("index.html")):
        html = page.read_text()
        if "sheet-band" not in html:
            continue
        band = _SheetBand()
        band.feed(html)
        out.append(("/" + page.parent.relative_to(PUBLIC).as_posix() + "/", band))
    return out


def test_every_product_page_renders_the_sheet_and_the_set_is_not_empty():
    paths = {p for p, _ in _sheet_pages()}
    expected = {site_path(s["link"]) for s in systems() if s.get("tier") == "product" and s.get("link")}
    assert expected - {"/quiet-corners/"} <= paths, (
        f"product pages without a sheet band: {sorted(expected - paths)}"
    )


def test_each_sheet_buy_box_leads_with_exactly_one_primary_action():
    bad = []
    for path, band in _sheet_pages():
        kinds = [k for k, _ in band.events]
        if "buy" not in kinds:
            continue  # a public dashboard product has no box by design
        actions = [k for k in kinds if k in ("primary", "secondary")]
        if actions.count("primary") != 1 or actions[0] != "primary":
            bad.append(f"{path}: actions {actions}")
        if kinds.index("buy") < kinds.index("h1"):
            bad.append(f"{path}: buy box before the name")
        if "details" in kinds and kinds.index("details") < kinds.index("buy"):
            bad.append(f"{path}: provenance disclosure above the action")
    assert not bad, "; ".join(bad)


def test_sheet_provenance_lives_in_a_details_disclosure_stated_once():
    bad = []
    for path, band in _sheet_pages():
        for text, inside in band.text:
            if re.search(r"Published|Latest release|Demo built from", text) and not inside:
                bad.append(f"{path}: provenance outside <details>: {text!r}")
        joined = " ".join(t for t, inside in band.text if inside)
        for label in ("Latest release", "Demo built from", "Published"):
            if joined.count(label) > 1:
                bad.append(f"{path}: {label!r} stated more than once")
    assert not bad, "; ".join(bad)
    with_release = [p for p, b in _sheet_pages() if any("Latest release" in t for t, _ in b.text)]
    assert with_release, "no sheet carries release provenance to check"


def test_sheet_band_has_no_shelf_or_engagement_wording():
    bad = []
    for path, band in _sheet_pages():
        for text, _ in band.text:
            if re.search(r"studio engagement|learn more|get in touch", text, re.I):
                bad.append(f"{path}: {text!r}")
    assert not bad, "; ".join(bad)
    pages = dict(_sheet_pages())
    for path in ("/driftless/", "/waypost/", "/grant-platform/"):
        assert ("primary", CONTACT) in pages[path].events, f"{path}: no primary contact action"
        assert any(t.startswith("Contact for setup") for t, _ in pages[path].text), (
            f"{path}: the contact action should read 'Contact for setup'"
        )


def test_the_404_page_reads_plainly_and_links_home():
    page = PUBLIC / "404.html"
    assert page.is_file(), "public/404.html missing -- build the site first"
    html = page.read_text()
    anchors = _Anchors()
    anchors.feed(html)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text.replace("&rsquo;", "'"))
    assert "Page not found. This link may be out of date." in text
    assert "Back to Headless Mode" in text
    assert re.search(
        r'<meta[^>]*name=["\']?description["\']?[^>]*content="Page not found\. This link may be out of date\."', html
    ), "the 404 meta description fallback was not updated"
    assert any(href == "/" for _, href in anchors.anchors), "no link to / on the 404"
    for stale in ("shelf", "shop", "for sale", "Learn more"):
        assert stale not in text, f"{stale!r} still on the 404 page"


def test_bot_battle_station_is_not_offered_as_a_windows_installer():
    """Its release is plain Python and HTML files for Linux/WSL and macOS. An entry with a
    download but no download_label/platforms renders the Windows-installer wording, which
    #845 shipped by mistake."""
    page = built("/bot-battle-station/").read_text()
    assert "SmartScreen" not in page
    assert "for Windows" not in page
    assert "Runs on Linux, macOS" in page


def _release_record(slug: str) -> dict:
    return json.loads((ROOT / "data" / "releases" / f"{slug}.json").read_text())


@pytest.mark.parametrize(
    "slug", [s for s in ("waypost", "framegrade") if _release_record(s)["release_source"] == "github-tag"]
)
def test_source_tag_details_render_ledger_without_invented_release_date(slug):
    record = _release_record(slug)
    html = built(f"/{slug}/").read_text()
    assert "Latest source tag" in html
    assert record["source_ref"] in html
    assert record["release_url"] in html
    assert record["source_commit"] in html
    assert "no GitHub Release assets" in html
    assert "Latest release" not in html
    assert "no installer or versioned release" not in html
    assert "January 0001" not in html


@pytest.mark.parametrize(
    "slug", [s for s in ("waypost", "framegrade") if _release_record(s)["release_source"] == "github-release"]
)
def test_published_release_details_link_each_asset_with_its_sha256(slug):
    """Once a product flips to github-release (Framegrade at v0.3.15), its
    Release details name the release, not a source tag, and link every asset."""
    record = _release_record(slug)
    html = built(f"/{slug}/").read_text()
    assert f"Latest release {record['version']}" in html
    assert "Latest source tag" not in html and "no GitHub Release assets" not in html
    assert record["assets"], f"{slug}.json is github-release with no assets"
    for name, asset in record["assets"].items():
        assert f'href="{asset["url"]}"' in html or f"href={asset['url']}" in html, name
        assert asset["sha256"] in html, name
    assert "January 0001" not in html


@pytest.mark.parametrize("slug", ["waypost", "framegrade"])
def test_source_provenance_links_use_the_hosted_checker_contract(slug):
    script = """
      import { readFileSync } from 'node:fs';
      import { extractLinks, planCheck } from './scripts/qcm/check-github-links.mjs';
      const links = extractLinks(readFileSync(process.argv[1], 'utf8'));
      const errors = links.filter(url => url.startsWith('https://github.com/Back-Road-Creative/' + process.argv[2] + '/'))
        .map(url => ({url, error: planCheck(url).error})).filter(result => result.error);
      if (errors.length) { console.error(JSON.stringify(errors)); process.exitCode = 1; }
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(built(f"/{slug}/")), slug],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
