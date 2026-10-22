"""bin/driftless-bundle-regen.sh and bin/driftless-prod-smoke.sh are the only
place the demo bundle's regeneration and production smoke are tracked.
validate_manifest_dir() must PASS on the CURRENT committed bundle (which
predates the 'pages'/'sha256' manifest keys, so those checks must skip
rather than fail); the smoke script must PASS end-to-end against a local
HTTP server standing in for production.
"""

import http.server
import json
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REGEN = ROOT / "bin" / "driftless-bundle-regen.sh"
SMOKE = ROOT / "bin" / "driftless-prod-smoke.sh"
BUNDLE = ROOT / "static" / "demo" / "driftless"
MANIFEST = BUNDLE / "manifest.json"


def _committed_source() -> str:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["source"]


@pytest.mark.parametrize("script", [REGEN, SMOKE])
def test_bash_syntax(script: Path) -> None:
    done = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize("script", [REGEN, SMOKE])
def test_shellcheck_if_present(script: Path) -> None:
    if shutil.which("shellcheck") is None:
        pytest.skip("shellcheck not on PATH")
    done = subprocess.run(["shellcheck", str(script)], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stdout + done.stderr


def test_validate_manifest_dir_passes_on_the_committed_bundle_honestly() -> None:
    """Source the regen script (stops after defining the function when
    DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY=1) and call validate_manifest_dir()
    against the bundle actually committed here.
    """
    script = f"""
set -uo pipefail
export DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY=1
source "{REGEN}"
validate_manifest_dir "{BUNDLE}" "{_committed_source()}"
"""
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    # The committed bundle carries the full manifest contract now (pages, sha256,
    # scripts, stylesheets), so every check runs for real — no "skip" line left.
    assert "\nskip " not in done.stdout
    assert "ok   pages = " in done.stdout
    assert "ok   sha256 index.html" in done.stdout
    assert "\nFAIL " not in done.stdout


def test_sync_release_demo_copies_the_new_bundle_into_the_release_record(tmp_path: Path) -> None:
    """A regen must leave data/releases/driftless.json agreeing with the bundle it
    just wrote (scripts/test_release_data.py checks source/anchor/pages), so the
    regen PR can't go red on a record nobody remembered to edit (#573, 2026-09-29).
    """
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"source": "v9.9.9", "anchor": "2031-01-02", "pages": 7, "files": []}), encoding="utf-8")
    record = tmp_path / "driftless.json"
    shutil.copyfile(ROOT / "data" / "releases" / "driftless.json", record)
    before = json.loads(record.read_text(encoding="utf-8"))
    script = f"""
set -euo pipefail
export DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY=1
source "{REGEN}"
sync_release_demo "{manifest}" "{record}"
"""
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    after = json.loads(record.read_text(encoding="utf-8"))
    assert after["demo"] == {**before["demo"], "source": "v9.9.9", "anchor": "2031-01-02", "pages": 7}
    assert {k: v for k, v in after.items() if k != "demo"} == {k: v for k, v in before.items() if k != "demo"}
    assert record.read_text(encoding="utf-8").endswith("}\n")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_prod_smoke_passes_against_a_local_server_standing_in_for_production(tmp_path: Path) -> None:
    """A plain `python3 -m http.server` only serves exact filenames, so
    production's clean-URL behaviour (Cloudflare Pages serves *.html at its
    extensionless path) is reproduced by also writing each page under its
    extensionless name before the server starts.
    """
    serve_root = tmp_path / "serve"
    demo_dir = serve_root / "demo" / "driftless"
    shutil.copytree(BUNDLE, demo_dir)
    for html_file in demo_dir.glob("*.html"):
        shutil.copyfile(html_file, html_file.with_suffix(""))

    port = _free_port()
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(serve_root), **kw)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        done = subprocess.run(
            ["bash", str(SMOKE), _committed_source(), "--base-url", f"http://127.0.0.1:{port}"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert "FAIL: 0" in done.stdout
        assert "\nFAIL " not in done.stdout
    finally:
        server.shutdown()
        server.server_close()
