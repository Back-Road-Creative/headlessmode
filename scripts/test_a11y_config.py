"""Every pa11y exemption cites something that still exists on the page it exempts.

An `ignore` / `hideElements` entry in .pa11yci.json turns a rule off for a URL, so
its `_ignore_comment` is the whole audit trail. The one exemption the file carried
(color-contrast on /quiet-corners/, 2026-07-30) justified itself with a methodology
<summary> block that #314 deleted a month later — the rule stayed switched off for
an element that no longer rendered. This test reads each comment, pulls out every
`<tag>`, `.class`, `#id` and `name.css` / `name.js` / `name.html` it names, and
asserts each one is present in the built page (public/<path>/index.html), the
theme's source layouts, or the vendored/static file the comment points at. A
comment that names nothing concrete fails too: an exemption with no locator is
unreviewable.

Reads public/ when it exists (CI builds first); the theme source is the fallback
so the test also runs in a fresh worktree.

Run: hugo --configDir site-config --minify && pytest scripts/test_a11y_config.py -v
"""

import json
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".pa11yci.json"
PUBLIC = ROOT / "public"
THEME = ROOT / "themes" / "headlessmode"
SOURCE_DIRS = (THEME / "layouts", ROOT / "layouts", ROOT / "content")
ASSET_DIRS = (THEME / "static", ROOT / "static")

TAG_RE = re.compile(r"<([a-z][a-z0-9-]*)>")
SELECTOR_RE = re.compile(r"(?<![\w/])([.#][A-Za-z_][\w-]+)\b")
FILE_RE = re.compile(r"\b([\w.-]+\.(?:css|js|html))\b")


def exemptions() -> list[dict]:
    urls = json.loads(CONFIG.read_text(encoding="utf-8"))["urls"]
    return [u for u in urls if isinstance(u, dict) and ("ignore" in u or "hideElements" in u)]


def rendered_corpus(url: str) -> str:
    """The exempted page as built, else every template that could render it."""
    path = urlparse(url).path.strip("/")
    built = PUBLIC / path / "index.html" if path else PUBLIC / "index.html"
    if built.is_file():
        return built.read_text(encoding="utf-8")
    return "\n".join(
        p.read_text(encoding="utf-8")
        for d in SOURCE_DIRS
        if d.is_dir()
        for p in d.rglob("*")
        if p.is_file()
    )


def named_files(comment: str) -> dict[str, str]:
    found = {}
    for name in set(FILE_RE.findall(comment)):
        for d in (*ASSET_DIRS, *SOURCE_DIRS):
            hits = list(d.rglob(name)) if d.is_dir() else []
            if hits:
                found[name] = "\n".join(h.read_text(encoding="utf-8") for h in hits)
                break
    return found


def present(token: str, corpus: str) -> bool:
    if token.startswith("<"):
        return re.search(rf"<{re.escape(token[1:-1])}\b", corpus, re.I) is not None
    name = token[1:]
    attr = "class" if token[0] == "." else "id"
    return re.search(rf'{attr}=["\']?[^"\'>]*\b{re.escape(name)}\b', corpus) is not None


def test_quiet_corners_is_gated_with_no_contrast_exemption() -> None:
    """Measured 2026-09-04: /quiet-corners/ passes color-contrast unaided (3 runs, 0 errors)."""
    urls = json.loads(CONFIG.read_text(encoding="utf-8"))["urls"]
    assert "http://localhost:1315/quiet-corners/" in urls
    assert not [e for e in exemptions() if "quiet-corners" in e["url"]]


@pytest.mark.parametrize("entry", exemptions(), ids=lambda e: urlparse(e["url"]).path)
def test_exemption_comment_cites_only_what_exists(entry: dict) -> None:
    comment = entry.get("_ignore_comment", "")
    assert comment.strip(), f"{entry['url']}: exemption without an _ignore_comment"

    files = named_files(comment)
    for name in FILE_RE.findall(comment):
        assert name in files, f"{entry['url']}: comment names {name}, which is not in the repo"

    corpus = rendered_corpus(entry["url"]) + "\n" + "\n".join(files.values())
    tokens = [f"<{t}>" for t in TAG_RE.findall(comment)] + SELECTOR_RE.findall(comment)
    tokens = [t for t in tokens if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", t)]  # colours
    assert tokens, f"{entry['url']}: comment names no element, tag or selector"
    missing = sorted({t for t in tokens if not present(t, corpus)})
    assert not missing, f"{entry['url']}: comment cites {missing}, absent from the page and its sources"


def test_sun_track_note_links_are_underlined() -> None:
    """pa11y link-in-text-block failed #837's CI on #st-fallback's link: the note is
    visible only until sun-track-demo.js adds .st-ready, so a slow runner saw a
    muted link told apart from its sentence by colour alone. An underline passes
    whatever the timing."""
    layout = (THEME / "layouts" / "_default" / "sun-track-demo.html").read_text()
    rule = re.search(r"\.st-note a\s*\{([^}]*)\}", layout)
    assert rule and "text-decoration: underline" in rule.group(1)
