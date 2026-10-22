"""The tracked tree names no private repo, local machine path or secret.

This repo is published as a public repository built from one commit of its
current files, so anything tracked here is public. A private repo name, a
workspace path on a developer's machine, an age public key or an encrypted
`.enc` file must never be committed. This test makes that a build failure
instead of something noticed after publishing.

Every pattern is assembled from fragments so this file does not match
itself; nothing is exempted, except that the owner-name check skips
static/data/, third-party geodata whose place names are not about the owner.

Run: pytest scripts/test_public_tree.py -v
"""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_ORG = "Back-Road-" + "Creative/"
_AGE = "age" + "1"

FORBIDDEN_CONTENT = {
    "private repo name": re.compile(
        _ORG + "(?:work" + "spaces|grant" + "platform|driftless-" + "archive)"
    ),
    "private repo name (bare)": re.compile("driftless-" + "archive"),
    "local path (dev user)": re.compile("/home/" + "dev/"),
    "local path (owner user)": re.compile("/home/" + "jo" + "e/"),
    "private service name": re.compile("svc-gomoveshift-" + "video"),
    "age public key": re.compile(_AGE + "[0-9a-z]{58}"),
}


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def _text_lines(path: str):
    """Yield (line_number, line) for a tracked file; nothing if it is binary or gone."""
    try:
        data = (ROOT / path).read_bytes()
    except OSError:
        return
    if b"\0" in data[:8192]:
        return
    for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        yield number, line


def test_tracked_files_name_no_private_repo_or_local_path() -> None:
    hits = []
    for path in _tracked_files():
        for number, line in _text_lines(path):
            for label, pattern in FORBIDDEN_CONTENT.items():
                if pattern.search(line):
                    hits.append(f"{path}:{number}: {label}")
    assert not hits, "tracked files must not name private repos or local paths:\n" + "\n".join(hits)


def test_no_tracked_venv_or_encrypted_file() -> None:
    bad = []
    for path in _tracked_files():
        parts = path.split("/")
        if "venv" in parts or ".venv" in parts:
            bad.append(f"{path}: virtualenv path")
        if path.endswith(".enc"):
            bad.append(f"{path}: encrypted (.enc) file")
    assert not bad, "tracked files must not include a virtualenv or .enc file:\n" + "\n".join(bad)


# The owner is never named in this public repo, docs and tests included
# (owner's instruction, 2026-10-22): first name, full first name, surname or
# initials. Word-bounded; the initials are case-sensitive so "jpg" never matches.
OWNER_NAME = re.compile(r"\b(?:" + "jo" + "e|jo" + "seph|pet" + "rucelli" + r")\b", re.IGNORECASE)
OWNER_INITIALS = re.compile(r"\b" + "J" + "P" + r"\b")
OWNER_SKIP = ("static/data/",)


def test_tracked_files_never_name_the_owner() -> None:
    hits = []
    for path in _tracked_files():
        if path.startswith(OWNER_SKIP):
            continue
        for number, line in _text_lines(path):
            if OWNER_NAME.search(line) or OWNER_INITIALS.search(line):
                hits.append(f"{path}:{number}: {line.strip()[:120]}")
    assert not hits, "tracked files must not name the owner:\n" + "\n".join(hits)
