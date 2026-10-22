"""scripts/preview.sh may only report a URL it has proven is this checkout's Hugo.

Real incident (2026-08-30): an unrelated Python HTTP server held port 1315, Hugo
failed to bind, and the helper printed `http://localhost:1315/demo/driftless/`
as ready. The page served was a different program and the demo route was a 404.

Real incident (2026-09-25): a fresh checkout's preview served /band-coach/ with
/css/tailwind.css 404ing — the head partial links it, but it is gitignored and
only `npm run build:css` emits it. Hugo alone never compiles it, so the page
rendered without Tailwind's preflight and looked broken for reasons nothing in
the theme CSS caused.

Real incident (2026-09-28, PR #617 CI): the helper gave Hugo a fixed 30 s to
report its bind. With three CI runners and two local browser suites on the one
box (load average 44-64) Hugo took longer than that to build the site and
listen, and the helper killed a Hugo that was seconds from binding, reporting
"hugo never reported a bind on port 49471". A Hugo that is still alive and has
not yet bound is not a failure; only a Hugo that died, or one that outlasts a
ceiling long enough for a loaded box, is. The ceiling is PREVIEW_BIND_WAIT
seconds (default 120) and the helper still stops the moment Hugo exits.
"""

import http.server
import os
import shutil
import socket
import stat
import subprocess
import threading
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / "scripts" / "preview.sh"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _slow_hugo_on_path(tmp_path: Path, delay_s: int) -> dict[str, str]:
    """An environment whose `hugo` sleeps delay_s, then becomes the real hugo.

    `exec` keeps the pid the helper recorded, so its alive/bound/served checks
    see exactly what a slow real Hugo on a loaded box looks like.
    """
    real = shutil.which("hugo")
    assert real, "hugo not installed"
    fake = tmp_path / "hugo"
    fake.write_text(f'#!/usr/bin/env bash\nsleep {delay_s}\nexec "{real}" "$@"\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    env = dict(os.environ)
    env["PATH"] = f"{tmp_path}{os.pathsep}{env['PATH']}"
    return env


class _ForeignHandler(http.server.BaseHTTPRequestHandler):
    """Answers 200 on / — exactly the signal the old helper trusted."""

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        body = b"<html><body>some other program</body></html>"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


def _run_preview(
    page: str, port: int, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(PREVIEW), page, str(port)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )


def test_a_foreign_server_on_the_port_is_never_reported_as_ready() -> None:
    port = _free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _ForeignHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        done = _run_preview("/demo/driftless/", port)
    finally:
        server.shutdown()
        server.server_close()
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)

    combined = done.stdout + done.stderr
    assert done.returncode != 0, f"helper reported success: {combined}"
    assert f"http://localhost:{port}" not in done.stdout, combined
    assert str(port) in combined, "the refusal must name the port it refused"


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_a_real_hugo_on_a_free_port_is_reported_with_port_specific_state() -> None:
    port = _free_port()
    try:
        done = _run_preview("/", port)
        assert done.returncode == 0, done.stdout + done.stderr
        assert f"http://localhost:{port}/" in done.stdout
        assert (ROOT / f".hugo-preview.{port}.pid").is_file(), "state must be per-port"
    finally:
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)
    assert not (ROOT / f".hugo-preview.{port}.pid").exists()


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_a_hugo_that_binds_after_the_old_30s_ceiling_is_still_reported(tmp_path: Path) -> None:
    """The 2026-09-28 shape: alive the whole time, bound at ~33 s. Under the old
    fixed 30 s loop this is the exact "never reported a bind" refusal."""
    port = _free_port()
    env = _slow_hugo_on_path(tmp_path, delay_s=33)
    env.pop("PREVIEW_BIND_WAIT", None)
    try:
        done = _run_preview("/", port, env=env)
        assert done.returncode == 0, done.stdout + done.stderr
        assert f"http://localhost:{port}/" in done.stdout
    finally:
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_the_bind_ceiling_is_a_real_ceiling(tmp_path: Path) -> None:
    """PREVIEW_BIND_WAIT is honoured: a Hugo slower than it is refused, named by
    port, and not left running — so the ceiling can be tightened where a slow
    bind should fail fast, and the default is not an unbounded wait."""
    port = _free_port()
    env = _slow_hugo_on_path(tmp_path, delay_s=6)
    env["PREVIEW_BIND_WAIT"] = "2"
    try:
        done = _run_preview("/", port, env=env)
    finally:
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)
    combined = done.stdout + done.stderr
    assert done.returncode != 0, f"helper reported success: {combined}"
    assert f"http://localhost:{port}" not in done.stdout, combined
    assert f"never reported a bind on port {port}" in combined, combined
    assert not (ROOT / f".hugo-preview.{port}.pid").exists()


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_a_route_that_404s_is_not_reported_as_ready() -> None:
    port = _free_port()
    try:
        done = _run_preview("/no-such-page-here/", port)
        assert done.returncode != 0, done.stdout + done.stderr
        assert f"http://localhost:{port}" not in done.stdout
    finally:
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
@pytest.mark.skipif(shutil.which("npm") is None, reason="npm not installed")
def test_preview_compiles_tailwind_so_the_linked_stylesheet_is_served() -> None:
    port = _free_port()
    css_path = ROOT / "themes" / "headlessmode" / "static" / "css" / "tailwind.css"
    saved = css_path.with_suffix(".css.movedaside")
    moved = False
    if css_path.exists():
        css_path.rename(saved)
        moved = True
    try:
        done = _run_preview("/", port)
        assert done.returncode == 0, done.stdout + done.stderr
        with urllib.request.urlopen(
            f"http://localhost:{port}/css/tailwind.css", timeout=5
        ) as resp:
            assert resp.status == 200
            body = resp.read().decode("utf-8", errors="replace")
        assert "max-width:100%" in body, "compiled output missing Tailwind preflight"
    finally:
        subprocess.run(["bash", str(PREVIEW), "--stop", str(port)], cwd=ROOT, check=False)
        if moved:
            saved.rename(css_path)
