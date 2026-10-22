#!/usr/bin/env python3
"""
TDD test suite for HeadlessMode content validation rules.

Enforces that a published data page carries data on every dimension it
advertises. The five prose rules that used to sit above this one (assumption,
extrapolation, disclosure, tense and uncertainty checks) read content/journal/
and nothing else; that section was retired with the journal, and a class that
iterates a directory Hugo no longer builds is a check that passes on absent
input — the exact hole scripts/test_systems_contract.py exists to close.

Run: pytest scripts/test_content_validation.py -v
"""

import pytest
import re
from pathlib import Path


def extract_frontmatter(content: str) -> dict:
    """Extract YAML frontmatter from markdown."""
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return {}
    
    fm = {}
    for line in match.group(1).split('\n'):
        if ':' in line:
            key, val = line.split(':', 1)
            fm[key.strip()] = val.strip().strip('"')
    return fm


class TestPublishedDataCoverage:
    """A published data page must not advertise a dimension it has no data for.

    The Quiet Corners pipeline degrades quietly by design of its sources: if a
    Census endpoint refuses a request, the dimension it feeds falls back to a
    default and the export still validates and still exits 0. That is how a
    dashboard ends up shipping an 'Afford' column of dashes and a composite
    score computed without one of its inputs.

    Coverage lives in the export, so the check reads the export rather than
    trusting the page. A draft page is exempt; publishing is the thing that
    makes an empty dimension a lie.
    """

    DIMENSIONS = ("stability", "remoteness", "affordability")

    def _site_root(self) -> Path:
        return Path(__file__).parent.parent

    def test_quiet_corners_export_has_coverage_on_every_dimension(self):
        import json

        root = self._site_root()
        summary_path = root / "static" / "data" / "quiet-corners" / "summary.json"
        page_path = root / "content" / "quiet-corners.md"

        # Absence is a FAILURE, not a skip: deleting the export (or the page)
        # used to turn the only data check green.
        missing = [p for p in (summary_path, page_path) if not p.exists()]
        if missing:
            pytest.fail(
                "Quiet Corners gate input(s) missing: "
                + ", ".join(str(p.relative_to(root)) for p in missing)
                + ". The export and the page ship together; regenerate via "
                "svc-quiet-corners instead of deleting."
            )

        fm = extract_frontmatter(page_path.read_text())
        if fm.get("draft", "false").lower() == "true":
            pytest.skip("Quiet Corners page is a draft")

        summary = json.loads(summary_path.read_text())
        coverage = summary.get("coverage", {})

        # A dimension dropped from the export must fail, not pass by omission.
        absent = [dim for dim in self.DIMENSIONS if dim not in coverage]
        if absent:
            pytest.fail(
                "summary.json coverage block is missing dimension key(s): "
                f"{', '.join(absent)}. Every dimension the dashboard "
                "advertises must report coverage."
            )

        empty = [
            dim
            for dim in self.DIMENSIONS
            if not (coverage[dim] or {}).get("pct", 0) > 0
        ]

        if empty:
            pytest.fail(
                "Quiet Corners is published but these dimensions have 0% coverage: "
                f"{', '.join(empty)}.\n"
                "The export was produced without a Census API key — api.census.gov "
                "answers keyless queries with missing_key.html as HTTP 200, so the "
                "run looks successful.\n"
                "Fix: get a free key (https://api.census.gov/data/key_signup.html), "
                "export CENSUS_API_KEY, re-run `python -m src.main --all "
                "<site>/static/data/quiet-corners` in svc-quiet-corners, and commit "
                "the regenerated JSON.\n"
                f"Export generated at: {summary.get('generated_at', 'unknown')}"
            )

    def test_sprawl_factor_coverage_has_no_dead_factors(self):
        """The exporter emits sprawl_factor_coverage; absence is a failure.

        The key went in with the exporter's contract (workspace #1735) and the
        committed summary.json has carried it since the 2026-07-31 regeneration,
        so an export without it is a regression, not a not-yet.
        """
        import json

        summary_path = (
            self._site_root() / "static" / "data" / "quiet-corners" / "summary.json"
        )
        if not summary_path.exists():
            pytest.fail("summary.json missing — see the coverage test above")

        factors = json.loads(summary_path.read_text()).get("sprawl_factor_coverage")
        if factors is None:
            pytest.fail(
                "summary.json has no sprawl_factor_coverage block. The exporter "
                "writes it for every run; an export missing it came from a "
                "pre-contract build — regenerate via `make quiet-corners-refresh`."
            )

        def covered(v):
            if isinstance(v, dict):
                return (v.get("count") or 0) > 0 or (v.get("pct") or 0) > 0
            return bool(v)

        dead = sorted(k for k, v in factors.items() if not covered(v))
        if dead:
            pytest.fail(
                "sprawl_factor_coverage reports zero-coverage factor(s): "
                f"{', '.join(dead)}. A factor whose source went away scores 0 "
                "everywhere and quietly deflates the composite — fix the "
                "source or drop the factor from the export."
            )


class TestFieldMapsDoc:
    """Field Maps documentation contract (content/quiet-corners-maps.md).

    The page documents a map that lives on the Quiet Corners dashboard, so it
    must open with a short description and a launch link, render a contents
    list, read in task order (area, layers, print, sources and limits,
    troubleshooting), and keep every heading anchor it had before the reorder.
    Source-level checks always run; the built-HTML checks need `public/` (Hugo
    build) and are skipped without it.
    """

    ROOT = Path(__file__).resolve().parent.parent
    CONTENT = ROOT / "content" / "quiet-corners-maps.md"
    LAYOUT = ROOT / "themes" / "headlessmode" / "layouts" / "_default" / "quiet-corners-maps.html"
    BUILT = ROOT / "public" / "quiet-corners" / "maps" / "index.html"

    # Heading ids the page had before the reorder (deep links, systems contract).
    LEGACY_ANCHORS = [
        "what-it-does", "starting-sets", "finding-and-checking-a-layer", "highlight",
        "what-a-boundary-does-not-mean", "status", "sources", "which-states-are-covered",
        "limits", "documentation", "terrain-in-3d", "source-decision-record",
        "printing-instructions", "road-names", "names--landmarks",
        "named-terrain-on-the-sheet", "printing-the-key-on-its-own",
        "calibrating-a-printer", "troubleshooting",
    ]
    OPENING_MAX_WORDS = 120

    def _body(self):
        return self.CONTENT.read_text().split("\n---\n", 1)[1]

    def _front_matter(self):
        return self.CONTENT.read_text().split("\n---\n", 1)[0]

    def _opening(self):
        """Text under `## What it does`, up to the next heading."""
        m = re.search(r"^## What it does\n(.*?)^## ", self._body(), re.S | re.M)
        assert m, "missing '## What it does' opening section"
        return m.group(1)

    def _built(self):
        if not self.BUILT.is_file():
            pytest.skip("public/ not built")
        return self.BUILT.read_text()

    def test_opening_is_short_and_links_to_the_dashboard(self):
        opening = self._opening()
        words = len(re.sub(r"\(.*?\)", "", opening).split())
        assert words <= self.OPENING_MAX_WORDS, f"opening is {words} words"
        assert re.search(r"\[Open field maps\]\(/quiet-corners/[^)]*\)", opening)

    def test_sections_read_in_task_order(self):
        heads = re.findall(r"^## (.+)$", self._body(), re.M)
        order = ["Choose an area", "Starting sets", "Print", "Sources", "Limits", "Troubleshooting"]
        idx = [heads.index(h) for h in order]
        assert idx == sorted(idx), f"out of order: {heads}"
        assert heads[-1] == "Troubleshooting"

    def test_layout_renders_title_and_contents_list(self):
        src = self.LAYOUT.read_text()
        assert ".TableOfContents" in src
        assert ".Title" in src

    def test_old_anchors_are_still_defined_in_source(self):
        body = self._body()
        heads = re.findall(r"^#{2,3} (.+?)(?: \{#([\w-]+)\})?$", body, re.M)
        ids = {explicit or re.sub(r"[^\w\- ]", "", h.lower()).replace(" ", "-") for h, explicit in heads}
        for slug in self.LEGACY_ANCHORS:
            if slug == "documentation":
                # The empty "## Documentation" heading was dropped; the layout
                # carries the anchor on the docs section instead.
                assert 'id="documentation"' in self.LAYOUT.read_text()
                continue
            assert slug in ids, slug

    def test_built_page_has_launch_link_contents_and_anchors(self):
        html = self._built()
        # --minify strips attribute quotes, so accept both spellings.
        ids = re.findall(r'\bid=["\']?([\w-]+)', html)
        assert "TableOfContents" in ids
        assert re.search(r'<a [^>]*href=["\']?/quiet-corners/[^>]*>\s*Open field maps', html)
        missing = [a for a in self.LEGACY_ANCHORS if a not in ids]
        assert not missing, missing

    def test_front_matter_makes_no_unverified_scale_claim(self):
        # The physical ruler-and-tape print check has not passed (see Status).
        assert not re.search(r"true[\s-]scale", self._front_matter(), re.I)

    def test_opening_privacy_link_sits_beside_the_no_server_claim(self):
        opening = self._opening()
        assert "no server" in opening
        assert "(/privacy/)" in opening

    def test_no_dangling_positional_reference_to_moved_sections(self):
        # Print now precedes Sources, so text before Sources must not say the
        # sources are "above"; point at the section by name instead.
        before_sources = self._body().split("\n## Sources\n", 1)[0]
        assert "MVUM above" not in before_sources
        for m in re.finditer(r"\b(?:sources?|source decision record) above\b", before_sources, re.I):
            pytest.fail(f"positional reference to a moved section: {m.group(0)}")

    def test_outdoor_text_paragraph_is_not_scoped_to_highlight(self):
        body = self._body()
        m = re.search(r"^## Highlight\n(.*?)^## ", body, re.S | re.M)
        assert m and "sized to be read outdoors" not in m.group(1)
        assert "sized to be read outdoors" in body.split("\n## Starting sets", 1)[0]

    def test_layout_keeps_one_product_h1_and_docs_title_is_h2(self):
        # The sheet band (product context) deliberately owns the page's single
        # H1; the documentation title is an h2 beneath it.
        src = self.LAYOUT.read_text()
        assert 'partial "system-sheet.html"' in src
        assert '<h2 class="qcm-doc-title">' in src
        assert "<h1" not in src

    def test_built_page_has_exactly_one_h1(self):
        assert len(re.findall(r"<h1[\s>]", self._built())) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
