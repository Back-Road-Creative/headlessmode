"""Every build of this site must go through scripts/build-site.sh.

The map's Content-Security-Policy is generated, not committed (see
scripts/qcm/gen-headers.mjs for why: one ~1,700-character line that every layer
branch rewrites, which on 2026-09-15 serialised six mutually-disjoint PRs into six
merge rounds). The cost of taking it out of git is that `hugo` alone no longer
produces a complete _headers: it emits the hand-written prefix, with no rule for
any map page, so every one of them falls back to the global same-origin policy and
can reach no service. The dashboard renders and stays empty — a failure that shows
up in production, not in a diff.

So this is the upstream gate: a caller that runs `hugo` to BUILD, rather than
scripts/build-site.sh, fails the suite here instead of shipping a policy-less site.
Running a `hugo server` is fine — a server writes no public/ for anyone to deploy.

The wrapper also compiles Tailwind before Hugo. The head partial links
/css/tailwind.css, which only the Tailwind CLI emits (`npm run build:css`, or
`watch:css`) and git ignores, so a build in a fresh checkout without it shipped
pages whose stylesheet 404ed. On 2026-10-02
three layout tests failed on such a build with numbers that looked like a real
regression. The wrapper tests below run a copy of it in a scratch repository with
stand-ins for hugo, node and npm, so they check what it runs, in order, without
building anything.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WRAPPER = ROOT / "scripts" / "build-site.sh"
TAILWIND_OUT = Path("themes") / "headlessmode" / "static" / "css" / "tailwind.css"

# `hugo` as the first token of a command: at the start of a line, or straight after
# a shell separator, a YAML `run:`, or validate.sh's `run_check "<label>"`.
HUGO_COMMAND = re.compile(
    r"""(?:^|&&|\|\||[;|]|run:\s|run_check\s+"[^"]*"\s)\s*hugo(?=\s|$)""",
    re.MULTILINE,
)
# Subcommands that build nothing deployable and so need no generated policy.
NON_BUILDING = ("server", "version", "env", "mod", "config", "--version", "help")

SEARCH_GLOBS = ("scripts/*.sh", ".github/workflows/*.yml", ".github/workflows/*.yaml", "Makefile")


def _tracked(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    return subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "--error-unmatch", rel],
        capture_output=True,
    ).returncode == 0


def _candidates() -> list[Path]:
    seen = []
    for pattern in SEARCH_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            if path.is_file() and path != WRAPPER and _tracked(path):
                seen.append(path)
    return seen


def test_the_wrapper_exists_and_is_executable():
    assert WRAPPER.is_file(), "scripts/build-site.sh is the only sanctioned build path"
    assert WRAPPER.stat().st_mode & stat.S_IXUSR, "scripts/build-site.sh must be executable"
    body = WRAPPER.read_text()
    assert "hugo" in body and "gen-headers.mjs --write-public" in body, (
        "the wrapper must run Hugo AND append the generated map policy"
    )


def test_no_caller_builds_with_bare_hugo():
    offenders = []
    for path in _candidates():
        text = path.read_text()
        for match in HUGO_COMMAND.finditer(text):
            rest = text[match.end():].lstrip()
            if rest.startswith(NON_BUILDING):
                continue
            line_no = text.count("\n", 0, match.start()) + 1
            line = text.splitlines()[line_no - 1].strip()
            offenders.append(f"{path.relative_to(ROOT)}:{line_no}: {line}")
    assert not offenders, (
        "these build with bare `hugo`, so they ship a _headers with no map CSP and every "
        "map page silently falls back to the global same-origin policy. Route them through "
        "`bash scripts/build-site.sh <same flags>`:\n  " + "\n  ".join(offenders)
    )


def test_the_generated_policy_is_not_committed():
    committed = (ROOT / "static" / "_headers").read_text()
    assert "# Quiet Corners Field Maps" not in committed, (
        "static/_headers carries the generated section again. It is one long line that every "
        "layer branch rewrites, so two such branches conflict on it even when they are otherwise "
        "disjoint — the 2026-09-15 six-round merge. It belongs in the build output."
    )


def _run_wrapper_copy(tmp_path: Path, *, cli: bool, stylesheet: bool, npm_rc: int = 0):
    """Run a copy of the wrapper in a scratch git repository and return (result, calls).

    `cli` puts an executable node_modules/.bin/tailwindcss in it, `stylesheet` an
    already-compiled tailwind.css. hugo, node and npm are stand-ins that append their
    command line to a log and exit 0 (npm exits `npm_rc`), so `calls` is what the
    wrapper ran, in order.
    """
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy2(WRAPPER, repo / "scripts" / "build-site.sh")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    if cli:
        cli_path = repo / "node_modules" / ".bin" / "tailwindcss"
        cli_path.parent.mkdir(parents=True)
        cli_path.write_text("#!/bin/sh\nexit 0\n")
        cli_path.chmod(0o755)
    if stylesheet:
        (repo / TAILWIND_OUT).parent.mkdir(parents=True)
        (repo / TAILWIND_OUT).write_text("/* compiled by an earlier build */\n")
    stand_ins = tmp_path / "bin"
    stand_ins.mkdir()
    log = tmp_path / "calls.log"
    for name, rc in (("hugo", 0), ("node", 0), ("npm", npm_rc)):
        stub = stand_ins / name
        stub.write_text(f'#!/bin/sh\necho "{name} $*" >> "{log}"\nexit {rc}\n')
        stub.chmod(0o755)
    env = dict(os.environ, PATH=f"{stand_ins}{os.pathsep}{os.environ['PATH']}")
    result = subprocess.run(
        ["bash", str(repo / "scripts" / "build-site.sh"), "--configDir", "site-config", "--minify"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls


def test_the_wrapper_compiles_tailwind_before_hugo(tmp_path):
    result, calls = _run_wrapper_copy(tmp_path, cli=True, stylesheet=False)
    assert result.returncode == 0, result.stderr
    assert calls and calls[0].split()[:3] == ["npm", "run", "build:css"], (
        f"the wrapper must compile Tailwind (`npm run build:css`) before anything else; it ran {calls}"
    )
    assert "hugo --configDir site-config --minify" in calls, calls


def test_a_failed_tailwind_compile_stops_the_build(tmp_path):
    result, calls = _run_wrapper_copy(tmp_path, cli=True, stylesheet=False, npm_rc=1)
    assert result.returncode != 0, "a failed `npm run build:css` must fail the build"
    assert not [c for c in calls if c.startswith("hugo")], (
        f"Hugo ran after the Tailwind compile failed: {calls}"
    )


def test_without_the_cli_a_compiled_stylesheet_is_used_and_flagged(tmp_path):
    # scripts/validate.sh builds the site for its HTML contracts without an npm install.
    result, calls = _run_wrapper_copy(tmp_path, cli=False, stylesheet=True)
    assert result.returncode == 0, result.stderr
    assert not [c for c in calls if c.startswith("npm")], calls
    assert "hugo --configDir site-config --minify" in calls, calls
    assert "tailwind.css" in result.stderr and "not recompiled" in result.stderr, (
        f"a build that reuses an old stylesheet must say so on stderr; it said {result.stderr!r}"
    )


def test_without_the_cli_or_a_stylesheet_the_build_refuses(tmp_path):
    result, calls = _run_wrapper_copy(tmp_path, cli=False, stylesheet=False)
    assert result.returncode != 0, "a build with no stylesheet ships pages whose /css/tailwind.css 404s"
    assert calls == [], f"the wrapper ran {calls} before refusing"
    assert "npm ci" in result.stderr, (
        f"the refusal must say how to get the Tailwind CLI; it said {result.stderr!r}"
    )
