"""Offline tests for bin/product-sync.sh (the sync step product-sync.yml
runs) and a YAML sanity check on the two workflows it touches.

Everything here runs against temp fixtures — a fake `gh api .../releases/
tags/<tag>` payload, a fake data/releases/<slug>.json, and for driftless a
fake showcase tarball whose manifest.json matches the real bundle's shape
(static/demo/driftless/manifest.json: anchor, files, kind, pages, scripts,
sha256, source, stylesheets). No network, nothing under _active/ touched.
"""

import hashlib
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "bin" / "product-sync.sh"
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"
PRODUCT_SYNC_YML = WORKFLOW_DIR / "product-sync.yml"
DRIFT_SENTINEL_YML = WORKFLOW_DIR / "drift-sentinel.yml"
RIGSCORE_FACTS_SYNC_YML = WORKFLOW_DIR / "rigscore-facts-sync.yml"

BAND_COACH_RELEASES = {
    "product": "band-coach",
    "name": "Band Coach",
    "release_source": "github-release",
    "source_repo": "Back-Road-Creative/band-coach",
    "version": "1.8.0",
    "released_at": "2026-01-01T00:00:00Z",
    "release_url": "https://github.com/Back-Road-Creative/band-coach/releases/tag/v1.8.0",
    "source_ref": "v1.8.0",
    "assets": {
        "band-coach.html": {"url": "https://example.invalid/old/band-coach.html"},
    },
    "demo": None,
    "media_source": None,
    "notes": "fixture",
    "custom_field": "must-survive-a-sync",
}


def _write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _release_payload(tag: str, assets: list[dict]) -> dict:
    return {
        "tag_name": tag,
        "published_at": f"2026-02-{tag[-1]}T00:00:00Z",
        "html_url": f"https://github.com/Back-Road-Creative/band-coach/releases/tag/{tag}",
        "assets": [
            {"name": a["name"], "browser_download_url": f"https://example.invalid/{tag}/{a['name']}"}
            for a in assets
        ],
    }


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.fixture
def releases_dir(tmp_path: Path) -> Path:
    d = tmp_path / "releases"
    d.mkdir()
    _write_json(d / "band-coach.json", BAND_COACH_RELEASES)
    return d


def test_bash_syntax() -> None:
    done = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr


def test_version_bump(tmp_path: Path, releases_dir: Path) -> None:
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    done = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode == 0, done.stdout + done.stderr

    data = json.loads((releases_dir / "band-coach.json").read_text(encoding="utf-8"))
    assert data["version"] == "1.9.0"
    assert data["source_ref"] == "v1.9.0"
    assert data["release_url"].endswith("v1.9.0")
    assert data["assets"]["band-coach.html"]["url"].endswith("v1.9.0/band-coach.html")


def test_sha256_comes_from_release_digest_when_not_downloaded(tmp_path: Path, releases_dir: Path) -> None:
    digest = "a" * 64
    payload = tmp_path / "release.json"
    body = _release_payload("v1.9.0", [{"name": "band-coach.html"}, {"name": "other.zip"}])
    body["assets"][0]["digest"] = f"sha256:{digest}"
    _write_json(payload, body)

    done = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode == 0, done.stdout + done.stderr

    assets = json.loads((releases_dir / "band-coach.json").read_text(encoding="utf-8"))["assets"]
    assert assets["band-coach.html"]["sha256"] == digest
    # No digest and no download: the key is still present (release data test requires it), as null.
    assert "sha256" in assets["other.zip"]
    assert assets["other.zip"]["sha256"] is None


def test_local_hash_wins_over_release_digest(tmp_path: Path, releases_dir: Path) -> None:
    asset = tmp_path / "band-coach.html"
    asset.write_text("<html></html>", encoding="utf-8")
    payload = tmp_path / "release.json"
    body = _release_payload("v1.9.0", [{"name": "band-coach.html"}])
    body["assets"][0]["digest"] = "sha256:" + "b" * 64
    _write_json(payload, body)

    done = _run(
        "band-coach", "v1.9.0", "--release-json", str(payload),
        "--releases-dir", str(releases_dir), "--asset", str(asset),
    )
    assert done.returncode == 0, done.stdout + done.stderr

    assets = json.loads((releases_dir / "band-coach.json").read_text(encoding="utf-8"))["assets"]
    assert assets["band-coach.html"]["sha256"] == _sha256(asset)


def test_unknown_keys_preserved(tmp_path: Path, releases_dir: Path) -> None:
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    done = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode == 0, done.stdout + done.stderr

    data = json.loads((releases_dir / "band-coach.json").read_text(encoding="utf-8"))
    assert data["custom_field"] == "must-survive-a-sync"
    assert data["product"] == "band-coach"
    assert data["notes"] == "fixture"


def test_a_release_sync_drops_a_source_tag_commit(tmp_path: Path, releases_dir: Path) -> None:
    """A record flipped from github-tag keeps the old tag's source_commit until a
    sync rewrites it. A Release payload carries no commit, so the stale one must
    go: the workflow's already-synced check compares it, and Release details
    would otherwise vouch for a commit the release never named."""
    _write_json(releases_dir / "band-coach.json", {**BAND_COACH_RELEASES, "source_commit": "c" * 40})
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    done = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode == 0, done.stdout + done.stderr

    data = json.loads((releases_dir / "band-coach.json").read_text(encoding="utf-8"))
    assert "source_commit" not in data


def test_rerun_same_tag_is_a_noop(tmp_path: Path, releases_dir: Path) -> None:
    """Running the sync twice for the already-current tag must not change the
    file the second time — idempotent, not merely skipped by the workflow's
    own version-check step.
    """
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    first = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert first.returncode == 0, first.stdout + first.stderr
    after_first = (releases_dir / "band-coach.json").read_text(encoding="utf-8")

    second = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert second.returncode == 0, second.stdout + second.stderr
    after_second = (releases_dir / "band-coach.json").read_text(encoding="utf-8")

    assert after_first == after_second


def test_missing_release_data_file_fails(tmp_path: Path, releases_dir: Path) -> None:
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    done = _run("waypost", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode != 0
    assert "not found" in (done.stdout + done.stderr)


def test_missing_required_keys_fails(tmp_path: Path, releases_dir: Path) -> None:
    _write_json(releases_dir / "band-coach.json", {"product": "band-coach"})
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    done = _run("band-coach", "v1.9.0", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode != 0
    assert "missing keys" in (done.stdout + done.stderr)


def test_payload_tag_mismatch_fails(tmp_path: Path, releases_dir: Path) -> None:
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v1.9.0", [{"name": "band-coach.html"}]))

    # CLI tag disagrees with the release json's own tag_name.
    done = _run("band-coach", "v1.9.1", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert done.returncode != 0
    assert "does not match" in (done.stdout + done.stderr)


# ---- Driftless: tarball extraction + manifest-source consistency --------

def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _make_driftless_tarball(tmp_path: Path, tag: str, manifest_source: str) -> Path:
    bundle_src = tmp_path / f"bundle-src-{manifest_source}-as-{tag}"
    bundle_src.mkdir()
    (bundle_src / "a.html").write_text("<html><body>a</body></html>", encoding="utf-8")
    (bundle_src / "b.html").write_text("<html><body>b</body></html>", encoding="utf-8")
    manifest = {
        "kind": "driftless-static-showcase",
        "source": manifest_source,
        "anchor": "2026-07-01",
        "pages": 2,
        "files": ["a.html", "b.html"],
        "scripts": [],
        "stylesheets": [],
        "sha256": {
            "a.html": _sha256(bundle_src / "a.html"),
            "b.html": _sha256(bundle_src / "b.html"),
        },
    }
    _write_json(bundle_src / "manifest.json", manifest)

    tarball = tmp_path / f"driftless-showcase-{tag}.tar.gz"
    with tarfile.open(tarball, "w:gz") as tf:
        for f in bundle_src.iterdir():
            tf.add(f, arcname=f.name)
    return tarball


@pytest.fixture
def driftless_releases_dir(tmp_path: Path) -> Path:
    d = tmp_path / "releases"
    d.mkdir()
    data = dict(BAND_COACH_RELEASES)
    data.update(
        product="driftless",
        name="Driftless",
        source_repo="Back-Road-Creative/driftless",
        version="0.6.1",
        source_ref="v0.6.1",
        assets={},
        demo={"path": "/demo/driftless/", "source_kind": "product-tag", "source": "v0.6.1", "anchor": "2026-06-01", "pages": 2},
    )
    _write_json(d / "driftless.json", data)
    return d


def test_driftless_version_bump_updates_demo(tmp_path: Path, driftless_releases_dir: Path) -> None:
    demo_dir = tmp_path / "demo" / "driftless"
    tarball = _make_driftless_tarball(tmp_path, "v0.6.2", manifest_source="v0.6.2")
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v0.6.2", [{"name": tarball.name}]))

    done = _run(
        "driftless", "v0.6.2",
        "--release-json", str(payload),
        "--asset", str(tarball),
        "--releases-dir", str(driftless_releases_dir),
        "--demo-dir", str(demo_dir),
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert (demo_dir / "manifest.json").exists()
    assert (demo_dir / "a.html").exists()

    data = json.loads((driftless_releases_dir / "driftless.json").read_text(encoding="utf-8"))
    assert data["version"] == "0.6.2"
    assert data["demo"]["source"] == "v0.6.2"
    assert data["demo"]["anchor"] == "2026-07-01"
    assert data["demo"]["pages"] == 2
    assert data["demo"]["path"] == "/demo/driftless/"  # untouched sub-key
    assert data["assets"][tarball.name]["sha256"] == _sha256(tarball)


def test_driftless_tag_manifest_mismatch_fails(tmp_path: Path, driftless_releases_dir: Path) -> None:
    demo_dir = tmp_path / "demo" / "driftless"
    # Tarball's own manifest.json claims a different source than the tag
    # we're syncing to — a build that doesn't match its release.
    tarball = _make_driftless_tarball(tmp_path, "v0.6.2", manifest_source="v0.6.1")
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v0.6.2", [{"name": tarball.name}]))

    done = _run(
        "driftless", "v0.6.2",
        "--release-json", str(payload),
        "--asset", str(tarball),
        "--releases-dir", str(driftless_releases_dir),
        "--demo-dir", str(demo_dir),
    )
    assert done.returncode != 0
    assert "does not match" in (done.stdout + done.stderr)


def test_driftless_requires_asset(tmp_path: Path, driftless_releases_dir: Path) -> None:
    payload = tmp_path / "release.json"
    _write_json(payload, _release_payload("v0.6.2", [{"name": "driftless-showcase-v0.6.2.tar.gz"}]))

    done = _run(
        "driftless", "v0.6.2",
        "--release-json", str(payload),
        "--releases-dir", str(driftless_releases_dir),
        "--demo-dir", str(tmp_path / "demo"),
    )
    assert done.returncode != 0
    assert "--asset" in (done.stdout + done.stderr)


# ---- YAML sanity on the workflows this unit adds/edits -------------------

def test_product_sync_yml_parses_and_is_not_named_sync_star() -> None:
    assert PRODUCT_SYNC_YML.exists(), "product-sync.yml must exist"
    assert not PRODUCT_SYNC_YML.name.startswith("sync-"), (
        "the autoland policy hard-denies .github/workflows/sync-*; the workflow "
        "must be named product-sync.yml"
    )
    with open(PRODUCT_SYNC_YML, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    assert doc is not None
    # PyYAML parses the unquoted `on:` key as the boolean True.
    triggers = doc.get("on") or doc.get(True) or {}
    assert "schedule" in triggers
    assert "workflow_dispatch" in triggers
    assert "repository_dispatch" in triggers
    assert "product-release" in triggers["repository_dispatch"].get("types", [])


def test_product_sync_dispatches_pr_ci_on_the_release_branch() -> None:
    """A PR the workflow token opens or force-pushes starts no PR CI run without a
    human approving it on GitHub (#821, 2026-10-19). The open step dispatches
    pr-ci.yml on the release branch after every push, new PR or updated one, and
    the job holds `actions: write` so the dispatch is allowed."""
    with open(PRODUCT_SYNC_YML, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    assert doc["permissions"].get("actions") == "write", doc["permissions"]
    script = next(
        s["run"] for s in doc["jobs"]["sync"]["steps"] if "gh pr create" in (s.get("run") or "")
    )
    dispatch = 'gh workflow run pr-ci.yml --ref "${BRANCH}"'
    assert dispatch in script, f"the open step never dispatches PR CI:\n{script}"
    # After the if/else that opens or updates the PR, so both paths reach it.
    assert script.index(dispatch) > script.rindex("\nfi"), script



def test_rigscore_facts_sync_dispatches_pr_ci_on_the_release_branch() -> None:
    """The same approval wait hit the rigscore facts PR: #61 (v2.3.0, 2026-10-28)
    sat at action_required with no PR CI jobs. Its open step dispatches pr-ci.yml
    after the open-or-update branch, and the workflow holds `actions: write`."""
    with open(RIGSCORE_FACTS_SYNC_YML, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    assert doc["permissions"].get("actions") == "write", doc["permissions"]
    script = next(
        s["run"] for s in doc["jobs"]["sync"]["steps"] if "gh pr create" in (s.get("run") or "")
    )
    dispatch = 'gh workflow run pr-ci.yml --ref "${BRANCH}"'
    assert dispatch in script, f"the open step never dispatches PR CI:\n{script}"
    assert script.index(dispatch) > script.rindex("\nfi"), script

def test_drift_sentinel_yml_still_parses() -> None:
    with open(DRIFT_SENTINEL_YML, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    assert doc is not None
    assert "jobs" in doc


# ---- The resolve step on a product with no published release --------------

def _resolve_step_script() -> str:
    """The `run:` script of the 'Resolve the target release' step, with the
    workflow expressions it uses rendered for a scheduled run."""
    with open(PRODUCT_SYNC_YML, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    steps = doc["jobs"]["sync"]["steps"]
    step = next(s for s in steps if s.get("name") == "Resolve the target release")
    script = step["run"]
    for expr, value in {
        "${{ github.event_name }}": "schedule",
        "${{ inputs.tag }}": "",
        "${{ github.event.client_payload.tag }}": "",
        "${{ matrix.slug }}": "driftless",
    }.items():
        script = script.replace(expr, value)
    assert "${{" not in script, f"unrendered expression in resolve step: {script}"
    return script


def test_resolve_step_skips_when_no_release_is_published(tmp_path: Path) -> None:
    """2026-09-26: the first product-sync run after #576 merged failed for
    driftless and opened an issue because the public mirror had no release
    yet (`gh api repos/…/releases/latest` → HTTP 404). A product that has
    not published anything is nothing to sync, not a broken sync."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gh = fake_bin / "gh"
    fake_gh.write_text(
        "#!/usr/bin/env bash\n"
        "echo 'gh: Not Found (HTTP 404)' >&2\n"
        "exit 1\n"
    )
    fake_gh.chmod(0o755)
    work = tmp_path / "work"
    (work / "data" / "releases").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "data" / "releases" / "driftless.json", work / "data" / "releases" / "driftless.json")
    output = tmp_path / "github_output"
    output.touch()
    env = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "GITHUB_OUTPUT": str(output),
        "GH_TOKEN": "x",
        "REPO": "Back-Road-Creative/driftless",
    }
    proc = subprocess.run(
        ["bash", "-c", _resolve_step_script()],
        cwd=work, env=env, capture_output=True, text=True,
    )
    assert proc.returncode == 0, f"a 404 on releases/latest must skip, not fail:\n{proc.stderr}"
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
    assert outputs.get("skip") == "true"
    assert "no published release" in (proc.stdout + proc.stderr)


def test_resolve_step_still_fails_on_other_api_errors(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gh = fake_bin / "gh"
    fake_gh.write_text(
        "#!/usr/bin/env bash\n"
        "echo 'gh: Bad credentials (HTTP 401)' >&2\n"
        "exit 1\n"
    )
    fake_gh.chmod(0o755)
    work = tmp_path / "work"
    (work / "data" / "releases").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "data" / "releases" / "driftless.json", work / "data" / "releases" / "driftless.json")
    output = tmp_path / "github_output"
    output.touch()
    env = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "GITHUB_OUTPUT": str(output),
        "GH_TOKEN": "x",
        "REPO": "Back-Road-Creative/driftless",
    }
    proc = subprocess.run(
        ["bash", "-c", _resolve_step_script()],
        cwd=work, env=env, capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "skip=true" not in output.read_text()


# Tagged source packages are distinct from GitHub Release objects. The resolver
# accepts captured GitHub tag-list pages so these contracts never use the network.
TAG_RESOLVER = REPO_ROOT / "bin" / "product-tag-resolve.py"


def _tag_payload(tmp_path, tags, requested=""):
    fixture = tmp_path / "tags.json"
    _write_json(fixture, tags)
    return subprocess.run(
        ["python3", str(TAG_RESOLVER), "Back-Road-Creative/waypost",
         "--tags-json", str(fixture), "--tag", requested],
        capture_output=True, text=True, timeout=30,
    )


def test_tag_resolver_chooses_stable_semver_across_pages(tmp_path):
    result = _tag_payload(tmp_path, [
        [{"name": "v0.9.0", "commit": {"sha": "a" * 40}},
         {"name": "v1.0.0-rc.1", "commit": {"sha": "b" * 40}}],
        [{"name": "v0.10.0", "commit": {"sha": "c" * 40}},
         {"name": "release/2026", "commit": {"sha": "d" * 40}}],
    ])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["tag_name"] == "v0.10.0"
    assert payload["source_commit"] == "c" * 40
    assert payload["release_source"] == "github-tag"
    assert payload["published_at"] is None  # commit time is not a release date
    assert payload["html_url"] == "https://github.com/Back-Road-Creative/waypost/tree/v0.10.0"
    assert payload["assets"] == []


@pytest.mark.parametrize("tags,requested", [
    ([], ""),
    ([{"name": "v1.0.0-rc.1", "commit": {"sha": "a" * 40}}], ""),
    ([{"name": "v1.0.0", "commit": {"sha": "a" * 40}}], "v2.0.0"),
    ([{"name": "v1.0.0", "commit": {"sha": "short"}}], ""),
])
def test_tag_resolver_refuses_missing_or_unverified_tag(tmp_path, tags, requested):
    result = _tag_payload(tmp_path, [tags], requested)
    assert result.returncode != 0
    assert not result.stdout


def test_tag_sync_preserves_demo_provenance_and_has_no_release_date(tmp_path, releases_dir):
    data = dict(BAND_COACH_RELEASES, product="waypost", release_source="github-tag",
                source_repo="Back-Road-Creative/waypost",
                demo={"source_kind": "site-commit", "source": "abc123"})
    _write_json(releases_dir / "waypost.json", data)
    payload = tmp_path / "release.json"
    _write_json(payload, {
        "tag_name": "v0.2.1", "release_source": "github-tag",
        "source_commit": "a" * 40, "published_at": None,
        "html_url": "https://github.com/Back-Road-Creative/waypost/tree/v0.2.1",
        "assets": [],
    })
    done = _run("waypost", "v0.2.1", "--release-json", str(payload),
                "--releases-dir", str(releases_dir))
    assert done.returncode == 0, done.stderr
    after = json.loads((releases_dir / "waypost.json").read_text())
    assert after["source_commit"] == "a" * 40
    assert after["released_at"] is None
    assert after["demo"] == data["demo"]
    assert after["assets"] == {}


def test_product_sync_includes_both_tagged_products():
    workflow = yaml.safe_load(PRODUCT_SYNC_YML.read_text())
    rows = {row["slug"]: row for row in workflow["jobs"]["sync"]["strategy"]["matrix"]["include"]}
    for slug in ("waypost", "framegrade"):
        assert rows[slug]["source_repo"] == f"Back-Road-Creative/{slug}"
        assert rows[slug]["asset_pattern"] == ""
    resolve = _resolve_step_script()
    assert "product-tag-resolve.py" in resolve
    assert "source_commit" in resolve  # a moved tag must not silently pass as current


@pytest.mark.parametrize("stored_commit,expected_skip", [("a" * 40, "true"), ("b" * 40, "false")])
def test_workflow_resolves_tag_and_detects_a_moved_tag(tmp_path, stored_commit, expected_skip):
    fixture = tmp_path / "tags.json"
    _write_json(fixture, [[{"name": "v0.2.1", "commit": {"sha": "a" * 40}}]])
    work = tmp_path / "work"
    (work / "data" / "releases").mkdir(parents=True)
    (work / "bin").mkdir()
    shutil.copy(TAG_RESOLVER, work / "bin" / TAG_RESOLVER.name)
    # The helper renders the slug as driftless; source kind selects the API.
    _write_json(work / "data" / "releases" / "driftless.json", {
        "version": "0.2.1", "release_source": "github-tag", "source_commit": stored_commit,
    })
    output = tmp_path / "github_output"
    output.touch()
    script = 'python3() { command python3 "$@" --tags-json "$TAGS_FIXTURE"; }\n' + _resolve_step_script()
    result = subprocess.run(
        ["bash", "-c", script], cwd=work,
        env={"PATH": "/usr/bin:/bin", "GITHUB_OUTPUT": str(output), "TAGS_FIXTURE": str(fixture),
             "REPO": "Back-Road-Creative/waypost"}, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
    assert outputs["tag"] == "v0.2.1"
    assert outputs["skip"] == expected_skip


@pytest.mark.parametrize("change", [
    {"source_commit": "bad"}, {"published_at": "2026-10-25T00:00:00Z"},
    {"html_url": "https://github.com/unrelated/repo/tree/v0.2.1"},
    {"assets": [{"name": "installer.exe", "browser_download_url": "https://example.invalid"}]},
])
def test_tag_sync_refuses_unsubstantiated_claims_without_mutation(tmp_path, releases_dir, change):
    path = releases_dir / "waypost.json"
    _write_json(path, dict(BAND_COACH_RELEASES, product="waypost", release_source="github-tag",
                           source_repo="Back-Road-Creative/waypost"))
    before = path.read_bytes()
    payload = tmp_path / "release.json"
    _write_json(payload, {
        "tag_name": "v0.2.1", "release_source": "github-tag", "source_commit": "a" * 40,
        "published_at": None, "html_url": "https://github.com/Back-Road-Creative/waypost/tree/v0.2.1",
        "assets": [], **change,
    })
    result = _run("waypost", "v0.2.1", "--release-json", str(payload), "--releases-dir", str(releases_dir))
    assert result.returncode != 0
    assert path.read_bytes() == before
