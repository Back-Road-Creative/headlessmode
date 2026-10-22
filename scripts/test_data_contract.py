#!/usr/bin/env python3
"""Site-owned contract test: JS fieldset vs the committed Quiet Corners export.

themes/headlessmode/static/js/quiet-corners.js reads a fixed set of fields off
the county / candidate / geo / state / summary records in
static/data/quiet-corners/*.json. Until this test, the only record of that
contract was a hand-copied comment in the workspace repo that nothing checked:
the exporter could rename a field and the dashboard would render dashes while
CI stayed green.

This test parses the JS for property reads on each record variable (the file
uses one conventional name per record type) and asserts every field it reads
exists on every committed record — a rename on either side goes red in PR CI.

Run: pytest scripts/test_data_contract.py -v
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
JS_PATH = ROOT / "themes" / "headlessmode" / "static" / "js" / "quiet-corners.js"
DATA_DIR = ROOT / "static" / "data" / "quiet-corners"

# Receiver variable -> the data file whose records it iterates.
RECEIVERS = {
    "c": "counties.json",  # county records
    "t": "candidates.json",  # candidate-town records
    "pt": "geo.json",  # geo points
    "np": "navigation-places.json",  # large places, map orientation labels only
    # states.json is gone. Its only reader, the sparklines renderer, was
    # deleted in audit C.15; then Census retired the PEP API vintages that fed
    # it (2020/2024/2025 all 404 — only 2019 and 2021 survive), so the pipeline
    # stopped producing it rather than migrating a file nothing read.
}


def _strip_strings_and_comments(src: str) -> str:
    """Drop string literals and comments so 'summary.json' in a fetch path or
    a comment is not mistaken for a property read."""
    src = re.sub(r"'(?:[^'\\\n]|\\.)*'", "''", src)
    src = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', src)
    # Line comments go FIRST, and the order is the whole point. This file carries
    # the comment "/data/quiet-corners/* is served with a ...", and with the block
    # pass in front that stray "/*" opens a comment that runs, DOTALL, to whatever
    # "*/" appears next -- in 2026-09 a JSDoc block a thousand lines below it,
    # taking every property read in between out of the scan. The test failed loudly
    # (js_fields returned nothing and the empty-set assertion caught it), but it
    # blamed the innocent file. A "//" inside a block comment is harmless in this
    # order: the block that contains it is removed either way.
    src = re.sub(r"//[^\n]*", " ", src)
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.DOTALL)
    return src


def js_fields(receiver: str) -> set:
    code = _strip_strings_and_comments(JS_PATH.read_text())
    return set(re.findall(rf"\b{re.escape(receiver)}\.([A-Za-z_]\w*)\b", code))


def load(filename: str):
    return json.loads((DATA_DIR / filename).read_text())


@pytest.mark.parametrize("receiver,filename", sorted(RECEIVERS.items()))
def test_every_field_the_js_reads_exists_on_every_record(receiver, filename):
    fields = js_fields(receiver)
    assert fields, (
        f"no '{receiver}.<field>' reads found in {JS_PATH.name} — record "
        "variable renamed? Update RECEIVERS in this test."
    )
    records = load(filename)
    assert isinstance(records, list) and records, (
        f"{filename}: expected a non-empty list of records"
    )
    problems = []
    for field in sorted(fields):
        missing = sum(1 for r in records if field not in r)
        if missing:
            problems.append(f"{field} (absent from {missing}/{len(records)} records)")
    assert not problems, (
        f"{filename} no longer satisfies the fields {JS_PATH.name} reads: "
        + "; ".join(problems)
    )


def test_summary_fields_the_js_reads_exist():
    fields = js_fields("summary")
    assert fields, f"no 'summary.<field>' reads found in {JS_PATH.name}"
    summary = load("summary.json")
    missing = sorted(f for f in fields if f not in summary)
    assert not missing, (
        "summary.json is missing fields the JS reads: " + ", ".join(missing)
    )


def test_coverage_entries_carry_the_fields_the_trust_panel_renders():
    fields = js_fields("cov")  # the trust panel renders cov.pct and cov.count
    assert fields, f"no 'cov.<field>' reads found in {JS_PATH.name}"
    coverage = load("summary.json").get("coverage", {})
    assert coverage, "summary.json has no coverage block"
    problems = [
        f"{dim}.{field}"
        for dim, entry in sorted(coverage.items())
        for field in sorted(fields)
        if field not in (entry or {})
    ]
    assert not problems, (
        "coverage entries missing fields the JS reads: " + ", ".join(problems)
    )


# --- Place shards: places-index.json + places-<ST>.json -------------------
# Every Census place, ranked by population, one file per state. These are not
# in RECEIVERS: the dashboard reads them through a shard loader (index first,
# then the shards a view needs), not a per-record variable the scan can name.
# The ids "t" (candidates.json) and "pt" (geo.json) stay reserved above.
# Pipeline gazetteer count at the W1 export (svc-quiet-corners d348e2c59,
# 32,333 places, 52 shards). A refresh that drops a place goes red here.
SHARD_PLACE_TOTAL = 32333
SHARD_FIELDS = ["geoid", "display_name", "lat", "lon", "population"]


def _shard_names(state: str):
    return [p[1] for p in load(f"places-{state}.json")["places"]]


def test_place_index_lists_every_shard_and_counts_match_the_shards():
    index = load("places-index.json")
    assert index, "places-index.json is empty"
    total = 0
    for state, entry in sorted(index.items()):
        shard = load(f"places-{state}.json")
        assert shard["state"] == state
        assert shard["fields"] == SHARD_FIELDS, f"{state}: field order changed"
        assert entry["count"] == len(shard["places"]), f"{state}: index count drifted"
        w, s, e, n = entry["bbox"]
        for row in shard["places"]:
            assert len(row) == len(SHARD_FIELDS), f"{state}: ragged row {row[:2]}"
            assert w <= row[3] <= e and s <= row[2] <= n, f"{state}: {row[1]} outside bbox"
        total += entry["count"]
    shards_on_disk = {p.stem[len("places-"):] for p in DATA_DIR.glob("places-??.json")}
    assert shards_on_disk == set(index), "shard files and places-index.json disagree"
    assert total == SHARD_PLACE_TOTAL, (
        f"shards hold {total} places, pipeline gazetteer has {SHARD_PLACE_TOTAL}"
    )


def test_the_shipped_nc_shard_names_franklin_by_census_geoid():
    rows = {r[0]: r for r in load("places-NC.json")["places"]}
    assert "3724640" in rows, "Franklin NC (GEOID 3724640) missing from the NC shard"
    assert rows["3724640"][1] == "Franklin"
    assert rows["3724640"][4] == 4362


def test_the_shipped_mt_shard_names_stevensville():
    assert "Stevensville" in _shard_names("MT")


# places-national.json: the head of the same ranking, state per row, one fetch from the
# first label zoom (pipeline PLACE_NATIONAL_HEAD / PLACE_SHARD_MAX_BYTES). It is a SLICE
# of the shards, never a third list: every row is its state shard's record, in rank order.
NATIONAL_HEAD_MAX = 1500
NATIONAL_HEAD_MAX_BYTES = 150_000


def test_national_head_is_a_ranked_slice_of_the_shards():
    path = DATA_DIR / "places-national.json"
    assert path.stat().st_size <= NATIONAL_HEAD_MAX_BYTES, "the head is one fetch; it must cost no more than one shard"
    head = load("places-national.json")
    assert head["fields"] == SHARD_FIELDS + ["state"], "field order changed"
    rows = head["places"]
    assert 0 < len(rows) <= NATIONAL_HEAD_MAX
    pops = [r[4] for r in rows]
    assert all(isinstance(p, int) for p in pops), "a head row without an estimate cannot be ranked"
    assert pops == sorted(pops, reverse=True), "the head is not in rank order"
    shard_rows: dict[str, dict] = {}
    for r in rows:
        st = r[5]
        if st not in shard_rows:
            shard_rows[st] = {s[0]: s for s in load(f"places-{st}.json")["places"]}
        assert shard_rows[st].get(r[0]) == r[:5], f"{r[1]} {st}: not the {st} shard's record"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


def test_a_path_in_a_line_comment_cannot_open_a_block_comment():
    """The scan reads real code, and one comment must not be able to hide it.

    quiet-corners.js has carried `// ... /data/quiet-corners/* is served ...`
    since the cache-buster note was written. With block comments stripped first,
    that `/*` swallowed everything up to the next `*/` anywhere in the file.
    """
    src = (
        "// a path like /data/quiet-corners/* in a comment\n"
        "var a = c.county_name;\n"
        "/** an ordinary doc block. */\n"
        "var b = c.state;\n"
    )
    kept = _strip_strings_and_comments(src)
    assert "c.county_name" in kept, "a line comment ate the code after it"
    assert "c.state" in kept, "a doc block closed a comment that was never open"
    assert "quiet-corners" not in kept, "the comment itself must still be gone"
