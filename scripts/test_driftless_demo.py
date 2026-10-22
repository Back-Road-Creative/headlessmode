"""The committed Driftless demo stays a closed, read-only generated bundle."""

import hashlib
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = "showcase-map.js"
DEMO = ROOT / "static" / "demo" / "driftless"
# The public source the site links (data/systems.json), so a hosted runner with no
# credential can still check the tag.
ARCHIVE_REMOTE = "https://github.com/Back-Road-Creative/driftless.git"


def _tag_unreachable(reason: str) -> None:
    """On CI an unreachable remote fails the test; off CI it skips."""
    message = f"{ARCHIVE_REMOTE} unreachable for git ls-remote: {reason}"
    if os.environ.get("CI") == "true":
        raise AssertionError(message)
    pytest.skip(message)


def test_product_page_links_to_the_generated_demo() -> None:
    page = (ROOT / "content" / "driftless.md").read_text(encoding="utf-8")
    assert "](/demo/driftless/)" in page


def _link_targets(page: str, *, rel: str) -> set[str]:
    targets: set[str] = set()
    for tag in re.findall(r"<link\b[^>]*>", page, re.I):
        if re.search(rf'rel="{rel}"', tag, re.I) is None:
            continue
        found = re.search(r'href="([^"]+)"', tag)
        if found:
            targets.add(found.group(1))
    return targets


def _script_srcs(page: str) -> set[str]:
    targets: set[str] = set()
    for tag in re.findall(r"<script\b[^>]*>", page, re.I):
        found = re.search(r'src="([^"]+)"', tag)
        if found:
            targets.add(found.group(1))
    return targets


def test_manifest_owns_every_published_page_and_the_bundle_is_inert() -> None:
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["kind"] == "driftless-static-showcase"
    assert manifest["anchor"] == "2026-07-01"
    source = manifest["source"]
    assert re.fullmatch(r"(?:v\d+\.\d+\.\d+|[0-9a-f]{7,40})", source)
    if source.startswith("v"):
        try:
            result = subprocess.run(
                ["git", "ls-remote", "--tags", ARCHIVE_REMOTE, f"refs/tags/{source}"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            _tag_unreachable(str(exc))
        if result.returncode != 0:
            _tag_unreachable(result.stderr.strip())
        assert result.stdout.strip(), f"tag {source!r} not found in {ARCHIVE_REMOTE}"

    pages = sorted(path.name for path in DEMO.glob("*.html"))
    # Since driftless v0.4.0 the method map carries ONE script, a DOM-only layer
    # (select a node, filter the legend); since the extensionless-links bundle the
    # two stylesheets ship once as sibling files too. Nothing else is a file.
    siblings = [SCRIPT, *manifest.get("stylesheets", [])]
    assert manifest["files"] == sorted([*pages, *siblings])
    manifest_html_count = sum(1 for name in manifest["files"] if name.endswith(".html"))
    assert manifest_html_count == len(pages)

    if "pages" not in manifest:
        pytest.skip(
            "manifest predates the manifest contract upgrade (missing 'pages'); "
            "the bundle regen PR adds pages/scripts/sha256"
        )
    assert manifest["pages"] == len(pages) == manifest_html_count

    page_bodies = {name: (DEMO / name).read_text(encoding="utf-8") for name in pages}

    scripts = manifest["scripts"]
    for name in scripts:
        assert (DEMO / name).exists(), f"manifest lists script {name!r} but it is missing on disk"
    referenced_scripts: set[str] = set()
    for body in page_bodies.values():
        referenced_scripts |= _script_srcs(body)
    unlisted_scripts = referenced_scripts - set(scripts)
    assert not unlisted_scripts, f"page references a script the manifest does not list: {unlisted_scripts}"
    unreferenced_scripts = set(scripts) - referenced_scripts
    assert not unreferenced_scripts, f"manifest lists a script no page references: {unreferenced_scripts}"

    if "stylesheets" in manifest:
        stylesheets = manifest["stylesheets"]
        for name in stylesheets:
            assert (
                DEMO / name
            ).exists(), f"manifest lists stylesheet {name!r} but it is missing on disk"
        referenced_stylesheets: set[str] = set()
        for body in page_bodies.values():
            referenced_stylesheets |= _link_targets(body, rel="stylesheet")
        unlisted_stylesheets = referenced_stylesheets - set(stylesheets)
        assert not unlisted_stylesheets, (
            f"page references a stylesheet the manifest does not list: {unlisted_stylesheets}"
        )
        unreferenced_stylesheets = set(stylesheets) - referenced_stylesheets
        assert not unreferenced_stylesheets, (
            f"manifest lists a stylesheet no page references: {unreferenced_stylesheets}"
        )

    for name, digest in manifest["sha256"].items():
        path = DEMO / name
        assert path.exists(), f"manifest sha256 references missing file {name!r}"
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        assert actual == digest, f"{name}: sha256 mismatch (manifest {digest}, disk {actual})"

    script = (DEMO / SCRIPT).read_text(encoding="utf-8")
    assert not re.search(
        r"\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|eval)\s*\(",
        script,
    ), "the map script talks to nothing and stores nothing"
    assert "document.cookie" not in script and "location.href" not in script

    for name in pages:
        page = (DEMO / name).read_text(encoding="utf-8")
        assert "Fixed fictional demo" in page, name
        assert '<meta name="robots" content="noindex, nofollow">' in page, name
        assert not re.search(r"<(?:form|button)\b", page, re.I), name
        # WHICH pages carry the map script is the generator's business, not this
        # repo's: bin/driftless-showcase.py gives it to every page in MAP_PAGES,
        # which is map.html AND map-all.html. Deriving the expectation from the
        # filename encoded a list this side cannot see change, and map-all.html
        # broke it. The manifest names the scripts the bundle owns but does not
        # map them to pages, so assert the property that actually matters: every
        # <script> on every page is one the manifest owns -- which still fails an
        # inline script, an unowned src, or a stray tag anywhere in the bundle.
        owned = {f'<script src="{asset}" defer>' for asset in manifest["scripts"]}
        page_scripts = re.findall(r"<script\b[^>]*>", page, re.I)
        assert set(page_scripts) <= owned, (name, page_scripts)
        assert not re.search(r'href="/(?!driftless/)', page), name


def test_every_static_demo_link_resolves_inside_the_bundle() -> None:
    """Links between bundle pages are extensionless (``href="process-map"``:
    Cloudflare Pages serves ``process-map.html`` at that path with no redirect
    hop), so htmltest cannot check them (it skips ``demo/driftless`` for this
    reason) and this test does: every relative href in every page names a page
    or a sibling file the manifest owns. The old form only matched ``.html``
    links and so matched nothing once they went extensionless."""
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    owned = set(manifest["files"])
    pages = {name[: -len(".html")] for name in owned if name.endswith(".html")}
    checked = 0
    for name in sorted(owned):
        if not name.endswith(".html"):
            continue
        page = (DEMO / name).read_text(encoding="utf-8")
        for href in re.findall(r'href="([^"]+)"', page):
            if href.startswith(("#", "/", "http://", "https://", "mailto:", "tel:")):
                continue
            target = re.sub(r"[?#].*$", "", href)
            checked += 1
            if target in ("./", ""):
                continue
            assert target in pages or target in owned, f"{name}: dangling href {href!r}"
    assert checked > 0, "no relative links found — the bundle's link shape changed"


# --- Offline structural accessibility pass (2026-09-04) ---------------------
# axe/pa11y and Lighthouse gate a representative sample of demo pages (at least
# the nine scripts/preview-shots.sh captures); this pass covers every page in
# the manifest without a browser.
# A red here is a driftless-showcase.py fix upstream, never a hand edit of the
# bundle — the strict xfails below name the pages the generator still gets wrong.

PAGES = sorted(path.name for path in DEMO.glob("*.html"))
SVG_TAG = re.compile(r"<svg\b[^>]*>", re.I)
FOCUSABLE_TAG = re.compile(r'<[^>]*\btabindex="0"[^>]*>', re.I)
# An SVG with links inside is a named group, not one image (role="img" prunes
# the subtree and axe refuses the nested controls); a chart with nothing to
# click is an image. Either is a named SVG.
ROLE_IMG = re.compile(r'\brole="(?:img|group)"')
ARIA_LABEL = re.compile(r'\baria-label(?:ledby)?="[^"]+"')
ARIA_HIDDEN = re.compile(r'\baria-hidden="true"')


def _page(name: str) -> str:
    return (DEMO / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", PAGES)
def test_page_has_one_h1_and_a_document_language(name: str) -> None:
    page = _page(name)
    assert len(re.findall(r"<h1\b", page, re.I)) == 1, name
    assert re.search(r'<html\b[^>]*\blang="[a-z]{2}(?:-[A-Za-z]+)?"', page), name


@pytest.mark.parametrize("name", PAGES)
def test_every_svg_is_named_or_hidden(name: str) -> None:
    # index.html and map.html were strict xfails here until driftless #421 gave
    # their two SVGs role="img"; the bundle regenerated from that fix passes.
    for tag in SVG_TAG.findall(_page(name)):
        named = ROLE_IMG.search(tag) and ARIA_LABEL.search(tag)
        assert named or ARIA_HIDDEN.search(tag), f"{name}: {tag[:120]}"


@pytest.mark.parametrize("name", PAGES)
def test_every_focusable_region_and_table_is_labelled(name: str) -> None:
    page = _page(name)
    for tag in FOCUSABLE_TAG.findall(page):
        assert ARIA_LABEL.search(tag), f"{name}: {tag[:120]}"
    for m in re.finditer(r"<table\b[^>]*>", page, re.I):
        block = page[m.end() : m.end() + 400]
        assert ARIA_LABEL.search(m.group(0)) or re.match(r"\s*<caption\b", block, re.I), (
            f"{name}: unlabelled table at {m.start()}"
        )


def _demo_urls(config: str, key_path: tuple[str, ...]) -> list[str]:
    node = json.loads((ROOT / config).read_text(encoding="utf-8"))
    for key in key_path:
        node = node[key]
    urls = [u if isinstance(u, str) else u["url"] for u in node]
    return [u for u in urls if "/demo/driftless/" in u]


@pytest.mark.parametrize(
    ("config", "key_path"),
    [(".pa11yci.json", ("urls",)), (".lighthouserc.json", ("ci", "collect", "url"))],
)
def test_browser_gates_cover_the_demo_with_pages_the_manifest_owns(
    config: str, key_path: tuple[str, ...]
) -> None:
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    urls = _demo_urls(config, key_path)
    assert len(urls) >= 9, f"{config}: the nine preview-shots demo pages are not all gated"
    for url in urls:
        name = url.split("/demo/driftless/", 1)[1] or "index.html"
        assert name in manifest["files"], f"{config}: {url} is not a manifest page"


# --- scripts/drift_probe_demo.py, the live check drift-sentinel.yml runs -----
# Offline: every request is answered from the committed bundle. A deploy that is
# the bundle byte for byte must pass. From 2026-09-26 it failed every day: the
# probe looked for the manifest's `source` tag in pages the generator never
# writes it into, and it hashed a page Cloudflare had added its beacon to.

SITE = "https://example.test"
# The line Cloudflare Web Analytics adds before </body> of every HTML response,
# with made-up values (never the live token).
CF_BEACON_LINE = (
    b'<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/'
    b'v00000000000000000000000000000000" integrity="sha512-AAAA"'
    b' data-cf-beacon=\'{"version":"2024.11.0","token":"0000","r":1}\''
    b' crossorigin="anonymous"></script>\n'
)


def _before_body_end(line: bytes) -> Callable[[str, bytes], bytes]:
    def serve(name: str, body: bytes) -> bytes:
        if not name.endswith(".html"):
            return body
        assert body.count(b"</body>") == 1, name
        return body.replace(b"</body>", line + b"</body>")

    return serve


def _probe_live(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    serve: Callable[[str, bytes], bytes] = lambda name, body: body,
) -> tuple[int, str]:
    monkeypatch.syspath_prepend(str(Path(__file__).parent))
    import drift_probe_demo

    base = f"{SITE}/demo/driftless/"

    def fetch(url: str) -> tuple[int, bytes]:
        if not url.startswith(base):
            return 404, b""
        rel = url.removeprefix(base)
        # Pages serves X.html at X, so an extensionless path names the .html file.
        name = "index.html" if rel == "" else rel if (DEMO / rel).is_file() else f"{rel}.html"
        if not (DEMO / name).is_file():
            return 404, b""
        return 200, serve(name, (DEMO / name).read_bytes())

    monkeypatch.setattr(drift_probe_demo, "results", [])
    monkeypatch.setattr(drift_probe_demo, "fetch", fetch)
    monkeypatch.setattr(sys, "argv", ["drift_probe_demo.py", SITE])
    rc = drift_probe_demo.main()
    return rc, capsys.readouterr().out


def test_live_probe_passes_a_deploy_identical_to_the_bundle(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    rc, out = _probe_live(monkeypatch, capsys)
    assert rc == 0, out
    assert "FAIL:" not in out


def test_live_probe_takes_out_cloudflares_beacon_before_hashing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    rc, out = _probe_live(monkeypatch, capsys, _before_body_end(CF_BEACON_LINE))
    assert rc == 0, out
    assert "beacon removed" in out, out


def test_live_probe_fails_any_other_script_added_to_a_page(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    other = CF_BEACON_LINE.replace(b"static.cloudflareinsights.com", b"cdn.example.test")
    rc, out = _probe_live(monkeypatch, capsys, _before_body_end(other))
    assert rc == 1, out
    assert "sha256 mismatch for index.html" in out, out


def test_live_probe_hashes_both_pages_it_fetches(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    rc, out = _probe_live(monkeypatch, capsys, _before_body_end(b"<!-- edited -->\n"))
    assert rc == 1, out
    mismatches = re.findall(r"^FAIL: sha256 mismatch for (\S+):", out, re.M)
    assert len(mismatches) == 2 and mismatches.count("index.html") == 1, out


def test_tag_check_reads_the_public_repo_the_site_links() -> None:
    """A hosted runner has no credential for a private repo, so the tag check must
    read the public source the site already links (data/systems.json)."""
    systems = json.loads((ROOT / "data" / "systems.json").read_text(encoding="utf-8"))
    entries = systems if isinstance(systems, list) else systems.get("systems", [])
    repos = {e.get("repo") for e in entries if e.get("link") == "/driftless/"}
    assert repos, "no data/systems.json entry links /driftless/"
    assert ARCHIVE_REMOTE.removesuffix(".git") in repos


def test_tag_check_fails_instead_of_skipping_on_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    """On CI an unreachable remote is a failure, never a silent skip."""
    monkeypatch.setenv("CI", "true")
    with pytest.raises(AssertionError, match="unreachable"):
        _tag_unreachable("network down")
    monkeypatch.delenv("CI")
    with pytest.raises(pytest.skip.Exception):
        _tag_unreachable("network down")
