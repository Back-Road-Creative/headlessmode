#!/usr/bin/env python3
"""Copy-metrics gate for HeadlessMode product pages. Stdlib-only.

Strips Hugo front matter, shortcodes, HTML comments and fenced code blocks,
then reports word count, sentence count, Flesch reading ease, every sentence
over --max-sentence-words, body link count, and British spellings (with line
numbers) from CONTENT_GUIDELINES.md's American-spelling rule (§ Writing
Style). Exits non-zero if any threshold is violated; prints one PASS/FAIL
line each.

Usage: scripts/copy_metrics.py <content/page.md> [--max-words N]
    [--min-fre N] [--max-sentence-words N] [--max-links N] [--links N]

Prose = the body with heading marks, emphasis marks, code spans and link
targets removed; link text still counts. A heading, a list item and a blank
line each end a sentence, then sentences split on ./!/? + whitespace.

Reading ease = 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words),
the standard Flesch formula. Syllables: vowel-group runs (a/e/i/o/u/y)
per word, minus one for a silent trailing "e" (unless the word ends "le"
after a consonant), floored at 1 — a heuristic, not a dictionary.

Spelling: CONTENT_GUIDELINES.md exempts proper nouns/paths and quoted
text. Rather than detect proper nouns, this exempts anything inside a
link target, code span, or double-quoted string. Line numbers are those of
the file on disk, front matter included.
"""
import argparse
import re
import sys

FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n?", re.DOTALL)
SHORTCODE_RE = re.compile(r"\{\{[%<].*?[%>]\}\}", re.DOTALL)
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
FENCE_RE = re.compile(r"^```.*?^```[ \t]*$", re.DOTALL | re.MULTILINE)
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
CODE_SPAN_RE = re.compile(r"`[^`]*`")
QUOTED_RE = re.compile(r'"[^"]*"')
BLOCK_START_RE = re.compile(r"^(#{1,6}\s+|\s*[-*+]\s+|\s*\d+[.)]\s+)", re.MULTILINE)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
WORD_RE = re.compile(r"[A-Za-z0-9']+")

# Fixed British spellings (CONTENT_GUIDELINES.md § Writing Style) outside
# the two suffix families below.
FIXED_WORDS = ["licence", "theatre", "judgement", "labelled", "artefact"]
FIXED_WORD_RE = re.compile(r"\b(" + "|".join(FIXED_WORDS) + r")\b", re.I)

# Explicit -our words, not a generic \w+our\b regex — that would also flag
# "four"/"your"/"hour"/"our". Optional plural/-ed/-ing suffix.
OUR_WORDS = ["colour", "behaviour", "honour", "labour", "favour", "flavour",
             "neighbour", "humour", "harbour", "armour", "rumour", "vapour",
             "endeavour", "savour", "valour", "splendour", "odour",
             "parlour", "candour", "clamour", "rigour", "vigour"]
OUR_WORD_RE = re.compile(r"\b(" + "|".join(OUR_WORDS) + r")(s|ed|ing)?\b", re.I)

# Explicit -ise stems, not a generic \w+ise\b regex — that would also flag
# "promise"/"exercise"/"surprise". base/-s/-d/-ing/-isation all hit.
ISE_STEMS = [w[:-1] for w in (
    "organise", "realise", "recognise", "summarise", "analyse", "normalise",
    "optimise", "prioritise", "categorise", "customise", "minimise",
    "maximise", "emphasise", "standardise")]
ISE_WORD_RE = re.compile(r"\b(" + "|".join(ISE_STEMS) + r")(e|es|ed|ing|ation)\b", re.I)

Metrics = dict[str, object]


def strip_frontmatter(text: str) -> str:
    return FRONTMATTER_RE.sub("", text, count=1)


def blank_out(m: re.Match[str]) -> str:
    """Replace a match with blank lines so later line numbers stay true."""
    return "\n" * m.group(0).count("\n")


def strip_noise(text: str) -> str:
    """Drop shortcodes, HTML comments and fenced code — none is prose."""
    text = SHORTCODE_RE.sub(blank_out, HTML_COMMENT_RE.sub(blank_out, text))
    return FENCE_RE.sub(blank_out, text)


def find_links(text: str) -> list[tuple[str, str]]:
    return LINK_RE.findall(text)


def prose_text(text: str) -> str:
    """Link targets replaced by their label — a URL isn't prose. Heading and
    emphasis marks and code spans go too; a block start ends a sentence."""
    text = CODE_SPAN_RE.sub(" ", LINK_RE.sub(lambda m: m.group(1), text))
    text = BLOCK_START_RE.sub("\n\n", text)
    return text.replace("*", "")


def spelling_check_text(text: str) -> str:
    """Link targets, code spans and quotes stripped so none can trigger a hit."""
    text = LINK_RE.sub(lambda m: m.group(1), text)
    return QUOTED_RE.sub(" ", CODE_SPAN_RE.sub(" ", text))


def words_of(text: str) -> list[str]:
    return WORD_RE.findall(text)


def sentences_of(text: str) -> list[str]:
    """Blank lines end a sentence, then a naive split on ./!/? + whitespace."""
    out: list[str] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        block = " ".join(block.split())
        out.extend(p.strip() for p in SENTENCE_SPLIT_RE.split(block) if p.strip())
    return out


def count_syllables(word: str) -> int:
    word = re.sub(r"[^a-z]", "", word.lower())
    if not word:
        return 0
    count = len(re.findall(r"[aeiouy]+", word))
    if word.endswith("e") and not word.endswith("le") and count > 1:
        count -= 1
    return max(count, 1)


def flesch_reading_ease(word_list: list[str], sentence_list: list[str]) -> float:
    if not word_list or not sentence_list:
        return 0.0
    syllables = sum(count_syllables(w) for w in word_list)
    return 206.835 - 1.015 * (len(word_list) / len(sentence_list)) - 84.6 * (
        syllables / len(word_list)
    )


def find_british_spellings(text: str) -> list[str]:
    hits = [m.group(0) for m in FIXED_WORD_RE.finditer(text)]
    hits.extend(m.group(0) for m in OUR_WORD_RE.finditer(text))
    hits.extend(m.group(0) for m in ISE_WORD_RE.finditer(text))
    return hits


def find_british_spellings_by_line(raw_text: str) -> list[tuple[int, str]]:
    """(line number, word) per hit; front matter counts toward the number."""
    matter = FRONTMATTER_RE.match(raw_text)
    body = strip_noise(raw_text[matter.end():] if matter else raw_text)
    first = matter.group(0).count("\n") + 1 if matter else 1
    return [(n, hit) for n, line in enumerate(body.split("\n"), start=first)
            for hit in find_british_spellings(spelling_check_text(line))]


def analyze(raw_text: str, max_sentence_words: int) -> Metrics:
    body = strip_noise(strip_frontmatter(raw_text))
    prose = prose_text(body)
    word_list = words_of(prose)
    sentence_list = sentences_of(prose)
    sentence_word_counts = [(s, len(words_of(s))) for s in sentence_list]
    over_limit = [sw for sw in sentence_word_counts if sw[1] > max_sentence_words]

    return {
        "word_count": len(word_list),
        "sentence_count": len(sentence_list),
        "longest_sentences": sorted(sentence_word_counts, key=lambda sw: -sw[1])[:3],
        "over_limit": over_limit,
        "reading_ease": flesch_reading_ease(word_list, sentence_list),
        "over_limit_count": len(over_limit),
        "link_count": len(find_links(body)),
        "british_spellings": find_british_spellings_by_line(raw_text),
    }


def preview(sentence: str) -> str:
    return sentence if len(sentence) <= 80 else sentence[:77] + "..."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="content/page.md to check")
    parser.add_argument("--max-words", type=int, default=800)
    parser.add_argument("--min-fre", type=float, default=60)
    parser.add_argument("--max-sentence-words", type=int, default=30)
    parser.add_argument("--max-links", type=int, default=3)
    parser.add_argument("--links", type=int, default=None,
                        help="exact body link count required (default: only --max-links)")
    args = parser.parse_args(argv)

    with open(args.path, encoding="utf-8") as f:
        m = analyze(f.read(), args.max_sentence_words)

    ok = True

    def report(label: str, passed: bool, detail: str) -> None:
        nonlocal ok
        print(f"{'PASS' if passed else 'FAIL'}: {label} — {detail}")
        ok = ok and passed

    report("Word count", m["word_count"] <= args.max_words,
            f"{m['word_count']} words (max {args.max_words})")
    report("Reading ease", m["reading_ease"] >= args.min_fre,
            f"Flesch {m['reading_ease']:.1f} (min {args.min_fre})")
    report("Sentence length", m["over_limit_count"] == 0,
            f"{m['over_limit_count']} sentence(s) over {args.max_sentence_words} words "
            f"of {m['sentence_count']} total")
    if args.links is None:
        report("Links", m["link_count"] <= args.max_links,
                f"{m['link_count']} link(s) (max {args.max_links})")
    else:
        report("Links", m["link_count"] == args.links,
                f"{m['link_count']} link(s) (exactly {args.links} required)")
    spellings: list[tuple[int, str]] = m["british_spellings"]  # type: ignore[assignment]
    report("Spelling", not spellings,
            f"{len(spellings)} British spelling(s): "
            f"{', '.join(f'line {n}: {w}' for n, w in spellings) or 'none'}")

    for label, key in (("Sentences over the limit", "over_limit"),
                       ("Longest sentences", "longest_sentences")):
        rows: list[tuple[str, int]] = m[key]  # type: ignore[assignment]
        if rows:
            print(f"{label}:")
            for sentence, wc in rows:
                print(f"  ({wc} words) {preview(sentence)}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
