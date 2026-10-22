"""The screenshot harness audits what it captures instead of only saving PNGs.

A human looking at pictures must not be the only thing standing between a broken
render and production, so the script fails on a 404, a capture error, a blank
image, or a document wider than its viewport (a screenshot pinned to the window
size cannot show that one; scripts/preview-overflow.mjs reads scrollWidth over
the DevTools protocol). These tests drive the real script against a throwaway
HTTP server.
"""

import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "preview-shots.sh"

# The nine demo pages carrying the riskiest displays. They shipped a
# thumbnail-sized method map and an empty Flow page while every structural gate
# stayed green, because the matrix never looked at them.
DEMO_PAGES = [
    "/demo/driftless/",
    "/demo/driftless/map.html",
    "/demo/driftless/process-map.html",
    "/demo/driftless/projects-1-flow.html",
    "/demo/driftless/projects-1-gantt.html",
    "/demo/driftless/org-heatmap.html",
    "/demo/driftless/projects-1-assist-cost.html",
    "/demo/driftless/methods.html",
    "/demo/driftless/pmbok-proof.html",
    "/grant-platform/",
    "/demo/grant-platform/",
    "/demo/grant-platform/awards.html",
    "/demo/grant-platform/reports-core.work_schedule.html",
    "/demo/grant-platform/reports-path.opportunity_matches.html",
    "/demo/waypost/",
    "/demo/waypost/pubqueue.html",
]

# Product pages the matrix must capture beside the demos.
PRODUCT_PAGES = ["/band-coach/", "/waypost/"]


def _chrome() -> str | None:
    return os.environ.get("CHROME_PATH") or shutil.which("chromium-browser") or shutil.which("chromium")


@pytest.fixture(scope="module")
def server(tmp_path_factory) -> str:
    root = tmp_path_factory.mktemp("site")
    (root / "blank.html").write_text('<html><body style="margin:0"></body></html>', encoding="utf-8")
    (root / "page.html").write_text("<html><body><h1>Real content here</h1></body></html>", encoding="utf-8")
    # A page that scrolls sideways at 390px, and one whose wide table scrolls
    # inside its own box — the second must pass, or the gate flags every table.
    (root / "wide.html").write_text(
        '<html><body><h1>Wide</h1><div style="width:3000px;height:20px;background:#333"></div></body></html>',
        encoding="utf-8",
    )
    (root / "scrolltable.html").write_text(
        '<html><body><h1>Boxed</h1><div style="overflow-x:auto;max-width:100%">'
        '<table><tr>' + "".join(f"<td style='min-width:200px'>col {i}</td>" for i in range(8)) + "</tr></table>"
        "</div></body></html>",
        encoding="utf-8",
    )
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    proc = subprocess.Popen(
        ["python3", "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)
    yield str(port)
    proc.terminate()
    proc.wait(timeout=10)


def _run(port: str, pages: str, out: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PREVIEW_SHOTS_PAGES": pages, "PREVIEW_SHOTS_WIDTHS": "390"}
    return subprocess.run(
        ["bash", str(SCRIPT), port, str(out)],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=300,
    )


def test_the_default_matrix_covers_every_risky_demo_page() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    for page in DEMO_PAGES:
        assert page in source, page


def _default_pages() -> list[str]:
    source = SCRIPT.read_text(encoding="utf-8")
    block = re.search(r'PAGES="\$\{PREVIEW_SHOTS_PAGES:-(.*?)\}"', source, re.S)
    assert block, "PAGES default not found"
    return block.group(1).replace("\\\n", " ").split()


def _route_exists(route: str) -> bool:
    if route.startswith("/demo/"):
        rel = route.lstrip("/")
        return (ROOT / "static" / (rel + "index.html" if route.endswith("/") else rel)).is_file()
    return (ROOT / "content" / (route.strip("/") + ".md")).is_file()


def test_the_default_matrix_covers_band_coach_and_waypost_pages() -> None:
    pages = _default_pages()
    for page in PRODUCT_PAGES + DEMO_PAGES:
        assert page in pages, page


def test_every_added_matrix_route_exists_in_the_source_tree() -> None:
    for route in PRODUCT_PAGES + DEMO_PAGES:
        assert _route_exists(route), route


def test_the_default_widths_are_desktop_and_phone() -> None:
    assert "PREVIEW_SHOTS_WIDTHS:-1440 390" in SCRIPT.read_text(encoding="utf-8")


@pytest.mark.skipif(_chrome() is None, reason="no chromium on PATH")
def test_a_404_fails_the_run(server, tmp_path) -> None:
    out = tmp_path / "shots-404"
    result = _run(server, "/nope.html", out)
    assert result.returncode != 0, result.stdout
    assert "404" in (out / "audit.tsv").read_text(encoding="utf-8")


@pytest.mark.skipif(_chrome() is None, reason="no chromium on PATH")
def test_a_blank_image_fails_the_run(server, tmp_path) -> None:
    out = tmp_path / "shots-blank"
    result = _run(server, "/blank.html", out)
    assert result.returncode != 0, result.stdout
    assert "blank" in (out / "audit.tsv").read_text(encoding="utf-8")


@pytest.mark.skipif(_chrome() is None, reason="no chromium on PATH")
def test_a_good_page_passes_and_is_audited(server, tmp_path) -> None:
    out = tmp_path / "shots-ok"
    result = _run(server, "/page.html", out)
    assert result.returncode == 0, result.stderr
    audit = (out / "audit.tsv").read_text(encoding="utf-8")
    assert "390x" in audit and "ok" in audit


@pytest.mark.skipif(_chrome() is None, reason="no chromium on PATH")
def test_a_page_wider_than_its_viewport_fails_the_run(server, tmp_path) -> None:
    out = tmp_path / "shots-wide"
    result = _run(server, "/wide.html", out)
    assert result.returncode != 0, result.stdout
    audit = (out / "audit.tsv").read_text(encoding="utf-8")
    assert "overflow-" in audit, audit


@pytest.mark.skipif(_chrome() is None, reason="no chromium on PATH")
def test_a_table_scrolling_inside_its_own_box_passes(server, tmp_path) -> None:
    out = tmp_path / "shots-boxed"
    result = _run(server, "/scrolltable.html", out)
    assert result.returncode == 0, result.stdout + result.stderr
    audit = (out / "audit.tsv").read_text(encoding="utf-8")
    assert "overflow-" not in audit, audit


# A stand-in chromium: the long-lived DevTools probe either takes FAKE_DELAY
# seconds to write DevToolsActivePort (a runner busy enough that a real
# chromium starts that slowly) or exits without writing it (FAKE_DELAY=die).
# Every screenshot call fails, so the run ends in capture-error either way and
# only the start-up wait is under test.
FAKE_CHROME = """#!/usr/bin/env bash
probe= dir=
for a in "$@"; do
    case "$a" in
        --remote-debugging-port=*) probe=1 ;;
        --user-data-dir=*) dir="${a#*=}" ;;
    esac
done
[ -n "$probe" ] || exit 1
[ "$FAKE_DELAY" = die ] && exit 0
sleep "$FAKE_DELAY"
mkdir -p "$dir"
printf '9\\n/devtools/browser/fake\\n' > "$dir/DevToolsActivePort"
exec sleep 120
"""


def _run_fake(tmp_path: Path, delay: str) -> tuple[subprocess.CompletedProcess, float]:
    fake = tmp_path / "chromium"
    fake.write_text(FAKE_CHROME, encoding="utf-8")
    fake.chmod(0o755)
    env = {**os.environ, "CHROME_PATH": str(fake), "FAKE_DELAY": delay,
           "PREVIEW_SHOTS_PAGES": "/", "PREVIEW_SHOTS_WIDTHS": "390"}
    start = time.monotonic()
    result = subprocess.run(
        ["bash", str(SCRIPT), "1", str(tmp_path / "shots")],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=300,
    )
    return result, time.monotonic() - start


def test_a_chromium_slow_to_start_on_a_busy_runner_is_waited_for(tmp_path) -> None:
    # PR CI run 37756427043 (#771) failed two tests with "chromium exposed no
    # DevTools port": the probe had 10 s to start while the runner was busy.
    result, _ = _run_fake(tmp_path, "12")
    assert "exposed no DevTools port" not in result.stderr, result.stderr
    # Port 1 serves nothing, so the one row the run reaches is an http-000.
    rows = (tmp_path / "shots" / "audit.tsv").read_text(encoding="utf-8").splitlines()[1:]
    assert [r.split("\t")[-1] for r in rows] == ["http-000"], rows


def test_a_chromium_that_dies_at_start_fails_at_once_and_says_so(tmp_path) -> None:
    result, took = _run_fake(tmp_path, "die")
    assert result.returncode != 0
    assert "exited before" in result.stderr, result.stderr
    assert took < 5, took
