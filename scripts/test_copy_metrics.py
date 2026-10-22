#!/usr/bin/env python3
"""TDD suite for scripts/copy_metrics.py. Run: pytest scripts/test_copy_metrics.py -v"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import copy_metrics  # noqa: E402

SIMPLE_PAGE = """---
title: "Simple page"
description: "A short simple page."
date: 2026-08-28
draft: false
---

{{< system-docs name="simple" >}}

## A short page

This page is short. Its sentences are short too. It should pass every
metric with room to spare.

See the [project source](https://github.com/Back-Road-Creative/simple) for
more.
"""

LONG_SENTENCE_PAGE = """---
title: "Long sentence page"
---

## A page with one long sentence

This is a short sentence.

This sentence keeps going and going and going and going and going and going
and going and going and going and going and going and going and going and
going and going and going and going and going and going and going and going
and going and going and going and going and going and going and going and going forever.

This is another short sentence.
"""

BRITISH_SPELLING_PROSE_PAGE = """---
title: "Colour page"
---

## Colour in prose

The dashboard uses a colour scheme that should be flagged.
"""

BRITISH_SPELLING_URL_PAGE = """---
title: "Reference page"
---

## A page linking to reference docs

See the [reference docs](https://example.com/colour/reference) for details.
"""

FENCED_CODE_PAGE = """---
title: "Fenced page"
---

## A page with a code block

Short prose before the block.

```python
# colour behaviour organise — none of this is prose, and this comment runs on and on
# and on and on and on and on and on and on and on and on and on and on and on and on
print("[a link](https://example.com/in/code)")
```

Short prose after the block, with a `colour` code span and a `# hash` span.
"""

HEADING_PAGE = """---
title: "Heading page"
---

## A heading with no full stop

- **A bold item.** Then a second sentence in the same item.
- A second item
"""


def write_page(tmp_path, name, content):
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


def sentence_page(n_words: int) -> str:
    return "---\ntitle: x\n---\n\n" + " ".join(f"word{i}" for i in range(n_words)) + ".\n"


def test_simple_page_passes_every_metric(tmp_path):
    page = write_page(tmp_path, "simple.md", SIMPLE_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    assert metrics["over_limit_count"] == 0
    assert metrics["british_spellings"] == []
    assert metrics["word_count"] <= 800
    assert metrics["link_count"] <= 3
    assert copy_metrics.main([str(page)]) == 0


def test_long_sentence_fails_only_sentence_length(tmp_path, capsys):
    page = write_page(tmp_path, "long.md", LONG_SENTENCE_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    assert metrics["over_limit_count"] == 1
    assert metrics["british_spellings"] == []
    assert metrics["link_count"] == 0
    assert copy_metrics.main([str(page)]) == 1
    out = capsys.readouterr().out
    assert "FAIL: Sentence length" in out
    assert "This sentence keeps going" in out  # every over-limit sentence is listed


def test_thirty_one_word_sentence_flagged_thirty_passes(tmp_path):
    ok = write_page(tmp_path, "30.md", sentence_page(30))
    bad = write_page(tmp_path, "31.md", sentence_page(31))
    assert copy_metrics.analyze(ok.read_text(), max_sentence_words=30)["over_limit_count"] == 0
    assert copy_metrics.analyze(bad.read_text(), max_sentence_words=30)["over_limit_count"] == 1
    assert copy_metrics.main([str(bad)]) == 1


def test_colour_in_prose_fails_with_line_number(tmp_path, capsys):
    page = write_page(tmp_path, "colour-prose.md", BRITISH_SPELLING_PROSE_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    # Line numbers are those of the file on disk, front matter included.
    assert metrics["british_spellings"] == [(5, "Colour"), (7, "colour")]
    assert copy_metrics.main([str(page)]) == 1
    assert "line 7: colour" in capsys.readouterr().out


def test_colour_in_url_passes(tmp_path):
    page = write_page(tmp_path, "colour-url.md", BRITISH_SPELLING_URL_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    assert metrics["british_spellings"] == []
    assert copy_metrics.main([str(page)]) == 0


def test_ordinary_words_pass_suffix_families_fail():
    assert copy_metrics.find_british_spellings("four your promise") == []
    hits = [h.lower() for h in copy_metrics.find_british_spellings("neighbours summarising")]
    assert hits == ["neighbours", "summarising"]


def test_link_count_mismatch_flagged(tmp_path, capsys):
    page = write_page(tmp_path, "simple.md", SIMPLE_PAGE)  # carries exactly one body link
    assert copy_metrics.main([str(page), "--links", "1"]) == 0
    assert copy_metrics.main([str(page), "--links", "3"]) == 1
    assert "FAIL: Links" in capsys.readouterr().out


def test_frontmatter_and_shortcodes_excluded(tmp_path):
    page = write_page(tmp_path, "simple.md", SIMPLE_PAGE)
    text = page.read_text(encoding="utf-8")
    metrics = copy_metrics.analyze(text, max_sentence_words=30)
    body = copy_metrics.strip_noise(copy_metrics.strip_frontmatter(text))
    assert metrics["word_count"] < 40  # front matter would otherwise inflate it
    assert "system-docs" not in body
    assert "{{<" not in body


def test_fenced_code_and_code_spans_excluded(tmp_path):
    page = write_page(tmp_path, "fenced.md", FENCED_CODE_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    assert metrics["word_count"] < 30
    assert metrics["over_limit_count"] == 0
    assert metrics["link_count"] == 0
    assert metrics["british_spellings"] == []
    assert copy_metrics.main([str(page)]) == 0


def test_heading_and_list_items_are_sentence_boundaries(tmp_path):
    page = write_page(tmp_path, "heading.md", HEADING_PAGE)
    metrics = copy_metrics.analyze(page.read_text(encoding="utf-8"), max_sentence_words=30)
    # heading | "A bold item." | "Then a second ... item." | "A second item"
    assert metrics["sentence_count"] == 4
    assert metrics["word_count"] == 20  # 6 + 3 + 8 + 3; no '#', '-' or '*' counted as words
