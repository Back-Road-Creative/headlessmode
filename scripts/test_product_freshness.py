"""Offline tests for the pure decision in bin/product-freshness.py."""

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

MOD_PATH = Path(__file__).resolve().parents[1] / "bin" / "product-freshness.py"
spec = importlib.util.spec_from_file_location("product_freshness", MOD_PATH)
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


def ago(hours):
    return NOW - timedelta(hours=hours)


def prod(tag="v0.3.0", have="0.3.0", tag_age=100, slug="waypost"):
    return {"slug": slug, "newest_tag": tag, "data_version": have,
            "tag_time": ago(tag_age) if tag else None}


def test_fresh():
    assert pf.evaluate(NOW, ago(5), [prod()]) == []


def test_run_too_old():
    out = pf.evaluate(NOW, ago(37), [prod()])
    assert len(out) == 1 and "product-sync" in out[0]


def test_never_ran():
    assert pf.evaluate(NOW, None, [prod()])


def test_lag_within_grace():
    assert pf.evaluate(NOW, ago(5), [prod(tag="v0.3.10", have="0.3.8", tag_age=10)]) == []


def test_lag_past_grace():
    out = pf.evaluate(NOW, ago(5), [prod(tag="v0.3.10", have="0.3.8", tag_age=40)])
    assert len(out) == 1 and "waypost" in out[0] and "0.3.10" in out[0]


def test_numeric_compare_not_lexical():
    assert pf.evaluate(NOW, ago(5), [prod(tag="v0.3.10", have="0.3.9", tag_age=40)])


def test_no_tag_skipped():
    assert pf.evaluate(NOW, ago(5), [prod(tag=None, have=None)]) == []
