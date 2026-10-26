"""This site checks its own governance contract.

WHY IT LIVES HERE, not in the workspace that consumes this repo as a submodule.
The Back Road Creative workspace runs a suite requiring Purpose / Owner /
Status / Exit Condition in every project README, and `content/_content.schema.yaml`
in every site-* project. It cannot enforce either here: no workflow in that repo
passes `submodules:` to actions/checkout, so this directory is empty in its CI
and both checks are skipped. Every site-* project is a submodule, so that
scanner reports green in CI having checked nothing at all.

The alternative was handing that repo's CI a cross-repo credential so it could
clone this one. A README and a content schema are properties of THIS project, so
the checks belong in THIS repo, where a violation cannot merge rather than being
noticed later somewhere else.
"""

import os
import re

import pytest
import yaml

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(REPO_ROOT, "README.md")
SCHEMA = os.path.join(REPO_ROOT, "content", "_content.schema.yaml")
HTMLTEST_CONFIG = os.path.join(REPO_ROOT, ".htmltest.yml")

REQUIRED_SECTIONS = ["Purpose", "Owner", "Status", "Exit Condition"]

# Heading text at # or ## — the same shape the workspace suite's parser matches.
HEADING_RE = re.compile(r"^#{1,2}\s+(.+)$")
ANY_HEADING_RE = re.compile(r"^#{1,6}\s+")


def read_readme():
    with open(README, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n").split("\n")


def test_readme_exists_and_is_not_a_stub():
    assert os.path.isfile(README), "README.md is missing"
    with open(README, encoding="utf-8") as f:
        assert len(f.read().strip()) > 50, "README.md is a stub"


@pytest.mark.parametrize("section", REQUIRED_SECTIONS)
def test_readme_states_its(section):
    headings = [
        m.group(1).strip().lower() for m in (HEADING_RE.match(line) for line in read_readme()) if m
    ]
    assert section.lower() in headings, (
        f"README.md has no '{section}' section. The workspace governance contract "
        f"requires {', '.join(REQUIRED_SECTIONS)}."
    )


@pytest.mark.parametrize("section", REQUIRED_SECTIONS)
def test_readme_section_has_a_body(section):
    """Four empty headings would satisfy the contract on a technicality."""
    lines = read_readme()
    start = None
    for i, line in enumerate(lines):
        m = HEADING_RE.match(line)
        if m and m.group(1).strip().lower() == section.lower():
            start = i
            break
    if start is None:
        pytest.skip(f"'{section}' is absent — test_readme_states_its covers that")

    body = []
    for line in lines[start + 1 :]:
        if ANY_HEADING_RE.match(line):
            break
        body.append(line)

    assert "".join(body).strip(), f"'{section}' is a heading with no body"


def test_content_schema_exists_and_parses():
    assert os.path.isfile(SCHEMA), (
        "content/_content.schema.yaml is missing — every site-* project needs one"
    )
    with open(SCHEMA, encoding="utf-8") as f:
        schema = yaml.safe_load(f)
    assert isinstance(schema, dict), "the schema is not a YAML mapping"

    for content_type, config in schema.items():
        if content_type in ("schema_version", "last_updated"):
            continue
        assert isinstance(config, dict), f"{content_type} is not a mapping"
        assert config.get("required"), f"{content_type} has no 'required' list"


def test_schema_required_lists_match_the_enforcing_script():
    """The schema is descriptive; scripts/test_frontmatter.py is the gate.

    Two contracts that can disagree is the failure this pairing exists to avoid,
    so the schema's `required` lists are pinned to what that script actually
    rejects a file for: `title` everywhere.
    """
    with open(os.path.join(REPO_ROOT, "scripts", "test_frontmatter.py"), encoding="utf-8") as f:
        enforcing = f.read()

    # Read the gate's own field set rather than restating it here.
    all_fields = re.search(r"REQUIRED_FIELDS_ALL\s*=\s*\{([^}]*)\}", enforcing)
    assert all_fields, "test_frontmatter.py no longer declares its field set"

    def names(match):
        return {n.strip().strip("\"'") for n in match.group(1).split(",") if n.strip()}

    with open(SCHEMA, encoding="utf-8") as f:
        schema = yaml.safe_load(f)

    # Every declared content type is pinned (releases retired with the
    # /releases/ section; "pages" is the one type left, but iterating the
    # schema keeps this true when a type is added).
    for content_type, config in schema.items():
        if content_type in ("schema_version", "last_updated"):
            continue
        assert set(config["required"]) == names(all_fields), content_type


# ── deploy branches must never share a name with an integration branch ──
# 2026-09-04: the (then unmerged) deploy-staging workflow published the Hugo
# build to a branch literally named `staging` (force_orphan, one commit, no
# ancestor in common with master). Every tool that reasons about the branch
# model by NAME then misread a build artifact as the integration branch: the
# merge wrapper refused master-based PRs, and retargeting two PRs onto that
# orphan made GitHub close them in the same API call. The workflow is the
# generator, so this is where the rule lives: a published build branch carries
# a `deploy/` prefix, and nothing in .github/workflows publishes to a name any
# integration-branch convention uses.
INTEGRATION_BRANCH_NAMES = {"master", "main", "staging", "develop", "development", "trunk"}
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")


def _published_branches():
    found = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS_DIR, name)
        with open(path, encoding="utf-8") as fh:
            for number, line in enumerate(fh, 1):
                match = re.match(r"\s*publish_branch:\s*['\"]?([\w./-]+)", line)
                if match:
                    found.append((name, number, match.group(1)))
    return found


def test_no_workflow_publishes_a_build_to_an_integration_branch_name():
    offenders = [
        f"{name}:{number}: publish_branch: {branch}"
        for name, number, branch in _published_branches()
        if branch in INTEGRATION_BRANCH_NAMES
    ]
    assert not offenders, (
        "a workflow publishes a build artifact to a branch named like an integration "
        "branch; use a deploy/ prefix so no tool mistakes it for one:\n" + "\n".join(offenders)
    )


def test_every_published_build_branch_is_namespaced():
    """`production` predates the rule and is the one legacy name allowed; anything new
    goes under deploy/ so the convention is visible in the branch list itself."""
    allowed_legacy = {"production"}
    offenders = [
        f"{name}:{number}: publish_branch: {branch}"
        for name, number, branch in _published_branches()
        if branch not in allowed_legacy and not branch.startswith("deploy/")
    ]
    assert not offenders, "published build branches must be deploy/<name>:\n" + "\n".join(offenders)


def _pr_triggered_workflows():
    """(name, parsed) for every workflow whose triggers include pull_request."""
    out = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        # PyYAML reads the unquoted key `on:` as the boolean True.
        triggers = doc.get("on", doc.get(True, {})) or {}
        if isinstance(triggers, str):
            triggers = {triggers: None}
        if "pull_request" in triggers:
            out.append((name, doc))
    return out


def test_no_pull_request_workflow_cancels_in_progress_runs():
    """GitHub reports a cancelled run as a failed check, so a shared concurrency group
    with cancel-in-progress lets each new PR turn every other open PR's check red and
    every merge wrapper refuse it. Five PRs stalled this way on 2026-09-05. Queue the
    runs instead."""
    offenders = [
        name
        for name, doc in _pr_triggered_workflows()
        if (doc.get("concurrency") or {}).get("cancel-in-progress") is True
        and not _group_is_per_pr(doc)
    ]
    assert not offenders, (
        "a pull_request workflow cancels in-progress runs in a group other PRs share; "
        "a cancelled run is a red check on the PR whose run was cancelled, so key the "
        "group on github.event.pull_request.number or set cancel-in-progress: false:\n"
        + "\n".join(offenders)
    )


def _group_is_per_pr(doc):
    """True when the concurrency group is keyed on the pull request's number, so the
    only run it can cancel is an older run of the SAME PR."""
    group = str((doc.get("concurrency") or {}).get("group") or "")
    return "github.event.pull_request.number" in group


def test_pr_ci_cancels_only_its_own_superseded_run():
    """PR CI keeps one run per PR: a new push cancels that PR's in-flight run.

    2026-09-26, the Quiet Corners stack: every squash of one PR meant merging master
    into each branch above it, and each push started a fresh run while the previous
    head's run kept going. The previous head can never merge, yet its run held one of
    the two `heavy` runners for up to 25 minutes, and the head that mattered queued
    behind it. With the box that loaded, page-load timeouts turned greens red.

    Cancelling is safe only because the group is per PR. The run it cancels belongs to
    a head that is no longer the PR's head, and both gh-approved-wrapper.sh and
    autoland.py judge the head SHA's runs alone. A shared group would still turn other
    PRs red, which test_no_pull_request_workflow_cancels_in_progress_runs refuses.
    """
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    concurrency = doc.get("concurrency") or {}
    assert _group_is_per_pr(doc), (
        "pr-ci.yml has no per-PR concurrency group, so a superseded head's run keeps "
        "a heavy runner busy after a new push: " + repr(concurrency)
    )
    assert concurrency.get("cancel-in-progress") is True, (
        "pr-ci.yml's per-PR group does not cancel the superseded run: " + repr(concurrency)
    )


def test_pr_ci_can_be_dispatched_for_a_bot_opened_pr():
    """product-sync opens its release PRs with the workflow token, and a PR opened that
    way starts no pull_request run a human did not approve: #821 sat at
    action_required until the owner clicked through on GitHub (2026-10-19). product-sync
    dispatches PR CI on the release branch instead, so the trigger must exist, and a
    dispatched run (no PR number) must group by its branch, not share one group that
    cancels every other dispatched run.
    """
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    trigger = doc.get("on", doc.get(True)) or {}
    assert "workflow_dispatch" in trigger, (
        "pr-ci.yml has no workflow_dispatch trigger, so product-sync cannot start CI "
        "on the release PR it opens: " + repr(list(trigger))
    )
    group = str((doc.get("concurrency") or {}).get("group") or "")
    assert "github.ref" in group, (
        "a dispatched pr-ci run has no PR number, so its concurrency group must fall "
        "back to the branch (github.ref): " + group
    )


NON_BASE_EDIT = "github.event.action == 'edited' && !github.event.changes.base"


def test_pr_ci_title_or_body_edit_neither_restarts_nor_cancels_the_run():
    """An `edited` event that does not change the base starts no CI and cancels none.

    `edited` stays in the trigger types for retargets, but GitHub also fires it for a
    title or body edit. In the per-PR group such an edit cancelled the head's in-flight
    run and started the same SHA again: 7 same-SHA reruns, about 163 runner-minutes,
    in the 7 days to 2026-10-20 (129 pr-ci runs). The edit's run gets a group of its
    own, so it cancels nothing; every job skips, so it holds no runner; and every job
    takes a different name, so its skipped checks never stand in for the real run's.
    """
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    group = str((doc.get("concurrency") or {}).get("group") or "")
    assert NON_BASE_EDIT in group and "github.run_id" in group, (
        "a title/body edit shares the PR's group, so it cancels the head's run: " + group
    )
    for job in ("scope", "pr-ci", "site-audit", "result"):
        spec = doc["jobs"][job]
        cond = str(spec.get("if") or "")
        assert f"!({NON_BASE_EDIT})" in cond, (
            f"{job} job runs on a title/body edit, re-testing an unchanged head: " + cond
        )
        name = str(spec.get("name") or "")
        assert NON_BASE_EDIT in name, (
            f"{job} job keeps its check name on a skipped edit run, so the skipped check "
            "can stand in for the real run's result: " + name
        )


def test_pr_ci_skips_a_stacked_child_until_it_is_retargeted():
    """A PR whose base is not the integration branch (`master`) gets no PR CI.

    A stacked child cannot merge until its parent lands and it is retargeted, yet it
    ran the full build+validate (28-45 min of chromium on a `heavy` runner), and a
    rebased stack queued several at once. The `if:` names the base; `edited` is in the
    trigger types because a retarget fires it, which starts CI for the retargeted PR.
    """
    path = os.path.join(WORKFLOWS_DIR, "pr-ci.yml")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    doc = yaml.safe_load(text)
    # PyYAML reads the bare key `on` as boolean True.
    trigger = doc.get("on", doc.get(True)) or {}
    types = (trigger.get("pull_request") or {}).get("types") or []
    for needed in ("edited", "ready_for_review"):
        assert needed in types, f"pr-ci.yml pull_request types lack {needed}: {types}"
    # Every job, not only pr-ci: `result` fails when a needed job is skipped, so a
    # child that ran `scope` and `result` but skipped `pr-ci` would show red.
    for job in ("scope", "pr-ci", "site-audit", "result"):
        cond = str(doc["jobs"][job].get("if") or "")
        assert "github.event.pull_request.base.ref" in cond and "'master'" in cond, (
            f"{job} job `if:` does not gate on the integration base branch: " + cond
        )
    header = text.split("\non:", 1)[0]
    assert "retarget" in header, "pr-ci.yml header does not state the retarget rule"


# scripts/test_*.py files PR CI deliberately does not run, each with its reason.
# Every other one must be named in pr-ci.yml. Eight files, the Field Maps privacy
# check among them, sat unwired: each looked like a gate and none ever ran, so a
# change that broke one merged green. Remove an entry when its file is wired.
NOT_RUN_BY_PR_CI = {
    "scripts/test_social_copy.py": "a CLI audit of one social-copy file passed as an "
    "argument (it defines no pytest tests), not a suite",
    "scripts/test_cv_audit.py": "a CLI guard for content/cv.md, which no longer exists; "
    "it exits 0 with 'audit skipped'",
}


def test_every_python_test_file_runs_in_pr_ci():
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        workflow = fh.read()
    scripts_dir = os.path.join(REPO_ROOT, "scripts")
    tests = sorted(
        f"scripts/{name}" for name in os.listdir(scripts_dir)
        if name.startswith("test_") and name.endswith(".py")
    )
    unwired = [t for t in tests if t not in workflow and t not in NOT_RUN_BY_PR_CI]
    assert not unwired, (
        "these test files exist but pr-ci.yml never runs them, so whatever they check "
        f"can merge broken: {unwired}. Add them to pr-ci.yml, or to NOT_RUN_BY_PR_CI "
        "with the reason"
    )
    stale = [t for t in NOT_RUN_BY_PR_CI if t in workflow or t not in tests]
    assert not stale, f"NOT_RUN_BY_PR_CI lists files that are now wired or gone: {stale}"


def _push_triggered_workflows():
    """(name, parsed) for every workflow whose triggers include push."""
    out = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        # PyYAML reads the unquoted key `on:` as the boolean True.
        triggers = doc.get("on", doc.get(True, {})) or {}
        if isinstance(triggers, str):
            triggers = {triggers: None}
        if "push" in triggers:
            out.append((name, doc))
    return out


def test_no_push_triggered_workflow_cancels_in_progress_runs():
    """The same cancelled-run-reads-as-failure trap as the pull_request rule above, on the
    branch the merge robot gates against.

    2026-09-20, twice in one morning. Run 35510341808 on cef7a420: six minutes into its
    deploy the next merge to master landed (12:26:43Z), this group cancelled it, and that
    head SHA was left `cancelled` for good. Then the robot itself did it — a86cb415's
    deploy started 14:11:35Z, the robot merged #549 at 14:16:17Z, and a86cb415's run was
    cancelled at 14:16:39Z, five minutes in. That is the failure feeding itself: the robot
    had just cleared its own auto-disable marker off a86cb415's barrier, and its very next
    merge turned that same SHA's run red.

    `cancelled` is a completed non-success, so the autoland robot
    reads such a barrier as failed and writes its own auto-disable marker
    (`/var/lib/autoland-headlessmode/status.json`: `"suspended": "auto-disabled"`). It
    holds no `actions: write` permission, so it cannot rerun the run to clear itself —
    only a further merge to master, which is the very thing it had just stopped doing.
    Queue the deploys instead.

    This does not make a cancelled run impossible: a concurrency group holds ONE pending
    run, so a third push still cancels the waiter (see
    test_no_pull_request_workflow_queues_in_a_shared_static_group). It does guarantee the
    NEWEST push — the head the barrier actually reads — is never the one cancelled.
    """
    offenders = [
        name
        for name, doc in _push_triggered_workflows()
        if (doc.get("concurrency") or {}).get("cancel-in-progress") is True
    ]
    assert not offenders, (
        "a push-triggered workflow cancels in-progress runs; a cancelled run is a "
        "completed non-success, which suspends the merge robot that gates on it, so set "
        "cancel-in-progress: false:\n" + "\n".join(offenders)
    )


def _htmltest_ignore_urls():
    """The IgnoreURLs list of the tracked root .htmltest.yml — the one config every
    link-checking gate reads."""
    with open(HTMLTEST_CONFIG, encoding="utf-8") as fh:
        conf = yaml.safe_load(fh)
    urls = conf.get("IgnoreURLs")
    assert urls, f"{HTMLTEST_CONFIG} checks external links but lists no IgnoreURLs"
    return urls


def test_no_workflow_writes_its_own_htmltest_config():
    """pr-ci.yml and deploy-production.yml run the same htmltest over the same build.
    When their allow-lists drifted, a link passed on the PR and then blocked the
    production deploy — the failure mode the Hugo --minify comment in pr-ci.yml already
    records. Both read the tracked root config now, so they cannot disagree; a workflow
    that writes its own copy would bring the drift back (and would put every allow-list
    change back behind a hand-merged .github/** edit)."""
    assert os.path.isfile(HTMLTEST_CONFIG), "the tracked root .htmltest.yml is missing"
    offenders = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            text = fh.read()
        if "cat > .htmltest.yml" in text or "CheckExternal: true" in text:
            offenders.append(name)
    assert not offenders, (
        "a workflow writes its own htmltest config instead of using the tracked root "
        ".htmltest.yml, so the PR gate and the deploy gate can drift apart:\n"
        + "\n".join(offenders)
    )


# node --test itself, or the evidence wrapper that runs it (QQA-12a): the wrapper passes
# its --test-* flags through to node --test, so its line needs the same per-file cap.
NODE_TEST_RE = re.compile(r"\bnode\s+(?:--test(?![-\w])|scripts/qcm/run-with-evidence\.mjs\b)")


def test_every_node_test_step_caps_each_file():
    """node --test has no timeout of its own, and the Field Maps tests drive a real
    chromium on a box three runners share: a browser that dies or starves does not
    fail the test, it waits. pr-ci.yml learned this and passes --test-timeout; the
    production deploy ran the same suite without it. On 2026-09-28 a host memory
    freeze left six of its browser test files parked in epoll_wait for 45 minutes,
    holding a heavy runner until the job's 60-minute timeout-minutes cancelled it --
    no failing file named, and every queued heavy job behind it waited. Every
    workflow step that runs node --test carries a per-file cap."""
    offenders = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            workflow = yaml.safe_load(fh) or {}
        for job_id, job in (workflow.get("jobs") or {}).items():
            for step in job.get("steps") or []:
                for line in str(step.get("run") or "").splitlines():
                    if NODE_TEST_RE.search(line) and "--test-timeout=" not in line:
                        offenders.append(f"{name} job {job_id}: {line.strip()}")
    assert not offenders, (
        "a workflow runs node --test with no --test-timeout, so a hung browser test "
        "holds the runner until the job's timeout-minutes and names no file:\n"
        + "\n".join(offenders)
    )


EVIDENCE_FILE = '"$RUNNER_TEMP/qcm-test-evidence.json"'
FIELD_MAPS_TEST_WORKFLOWS = ("pr-ci.yml", "deploy-production.yml")


def test_field_maps_suite_leaves_evidence_and_the_evidence_is_checked():
    """A green node --test only says nothing failed. It does not say every test file ran,
    that no suite was skipped, or that the run was of the commit being shipped -- and
    helpers/site-server.mjs skips its browser tests when there is no build, which once let
    the deploy gate run 528 of 603 tests green (deploy-production.yml records it). QQA-12a:
    both workflows that run the Field Maps suite run it through run-with-evidence.mjs, and
    a later step holds that record to this commit with check-evidence.mjs, so a skipped
    suite, a missing file or a partial run fails the job instead of passing it. The sha is
    github.sha, not HEAD: the record must match the commit the workflow was started for."""
    problems = []
    for name in FIELD_MAPS_TEST_WORKFLOWS:
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            workflow = yaml.safe_load(fh) or {}
        steps = [s for job in (workflow.get("jobs") or {}).values() for s in job.get("steps") or []]
        runs = [str(s.get("run") or "") for s in steps]
        for i, run in enumerate(runs):
            for line in run.splitlines():
                if re.search(r"\bnode\s+--test(?![-\w])", line) and "scripts/qcm/" in line:
                    problems.append(f"{name}: runs the Field Maps suite with bare node --test: {line.strip()}")
        producer = [i for i, r in enumerate(runs) if "scripts/qcm/run-with-evidence.mjs" in r]
        if not producer:
            problems.append(f"{name}: no step runs scripts/qcm/run-with-evidence.mjs")
            continue
        if f"--out {EVIDENCE_FILE}" not in runs[producer[0]]:
            problems.append(f"{name}: run-with-evidence.mjs does not write --out {EVIDENCE_FILE}")
        checker = [i for i, r in enumerate(runs) if "scripts/qcm/check-evidence.mjs" in r]
        if not checker or checker[0] <= producer[0]:
            problems.append(f"{name}: no step after the test run checks the evidence")
            continue
        check = runs[checker[0]]
        for needed in (f"--evidence {EVIDENCE_FILE}", '--sha "${{ github.sha }}"',
                       "--require scripts/test-verify-claims.js"):
            if needed not in check:
                problems.append(f"{name}: check-evidence.mjs step lacks {needed}")
        if steps[checker[0]].get("continue-on-error"):
            problems.append(f"{name}: the evidence check is continue-on-error, so it gates nothing")
    assert not problems, "\n".join(problems)

def _third_party_data_domains():
    """The registrable domains the Field Maps app draws its data from, read out of the
    app's own source registry rather than restated here — so adding a source to the
    registry is what puts its host on the allow-list, and no list can go stale."""
    registry = os.path.join(
        REPO_ROOT, "themes/headlessmode/static/js/quiet-corners-maps/source-registry.js"
    )
    with open(registry, encoding="utf-8") as fh:
        origins = re.findall(r"origin:\s*'https://([a-z0-9.-]+)'", fh.read())
    assert origins, f"{registry} declares no source origins"
    return {".".join(host.split(".")[-2:]) for host in origins}


def _third_party_data_hosts():
    """Every host the source registry links to (origins, service, metadata and terms
    pages), since the page cites all of them and htmltest probes each one."""
    registry = os.path.join(
        REPO_ROOT, "themes/headlessmode/static/js/quiet-corners-maps/source-registry.js"
    )
    with open(registry, encoding="utf-8") as fh:
        hosts = set(re.findall(r"'https://([a-z0-9.-]+)[/']", fh.read()))
    assert hosts, f"{registry} names no https hosts"
    # The page copy cites hosts the registry never names: the state road-camera feeds
    # (source-camera.js) and the camera operators' pages. On 2026-10-22 the #18 deploy
    # went red on 403s from chart.maryland.gov and www.njta.gov, both cited only there.
    page = os.path.join(REPO_ROOT, "content/quiet-corners-maps.md")
    with open(page, encoding="utf-8") as fh:
        hosts |= set(re.findall(r"\(https://([a-z0-9.-]+)[/)]", fh.read()))
    return hosts


def test_third_party_data_hosts_are_not_probed_on_every_run():
    """The Field Maps page cites its sources' terms and service pages. On 2026-09-06 the
    whole fs.usda.gov estate reset connections (curl exit 56) and 502'd, turning two green
    PRs red on a link the site does not control; on 2026-09-09 basemap.nationalmap.gov
    502'd and 504'd and did the same to three. Every host the app itself names is allow-
    listed for the same reason x.com and linkedin.com are: their liveness is a scheduled
    concern, not a per-PR one."""
    assert _third_party_data_domains()
    # Match each host the registry names against the IgnoreURLs regexes themselves. A
    # substring check on the registrable domain passed `usda.gov` on the strength of the
    # fs.usda.gov entry, so the SNOTEL rows' wcc.sc.egov.usda.gov and www.nrcs.usda.gov
    # links went unlisted and turned PR #6 red on a 404 and a timeout (2026-10-22).
    patterns = [re.compile(u) for u in _htmltest_ignore_urls()]
    for host in sorted(_third_party_data_hosts()):
        url = f"https://{host}/"
        assert any(p.search(url) for p in patterns), (
            f".htmltest.yml still probes {host} on every run; a third-party outage "
            "there turns unrelated PRs red"
        )


def _node_versions():
    """Every workflow that sets up Node, mapped to the version it pins."""
    out = {}
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            text = fh.read()
        found = re.findall(r"node-version:\s*'?\"?([0-9.]+)'?\"?", text)
        if found:
            out[name] = sorted(set(found))
    return out


def test_every_workflow_pins_the_same_node_version():
    """PR CI ran Node 22 while the deploy workflows ran Node 20, so a test could pass the
    PR gate and fail the deploy. It did: global WebSocket exists only from Node 22, so
    scripts/qcm/browser.test.mjs went green on #376 and then failed the production deploy
    of that same commit, leaving the live site a commit behind. The gates must agree on
    the runtime or 'green on the PR' stops meaning 'green on the deploy'."""
    versions = _node_versions()
    assert versions, "no workflow pins a Node version; this test is checking nothing"
    distinct = {v for pins in versions.values() for v in pins}
    assert len(distinct) == 1, (
        "workflows disagree about the Node version, so a PR can be green and its deploy "
        "red:\n" + "\n".join(f"{name}: {pins}" for name, pins in versions.items())
    )


def test_no_pull_request_workflow_queues_in_a_shared_static_group():
    """A concurrency group holds ONE pending run, so `cancel-in-progress: false` is
    not enough on its own.

    2026-09-05 set that flag on deploy-staging.yml after five PRs stalled, and the
    running job did stop being killed. The PENDING one is still displaced: when a
    third run arrives, GitHub cancels the one that was waiting. On 2026-09-09 a
    push across eight stacked branches created eight runs in 24 seconds and SEVEN
    came back `cancelled`, leaving seven PR head SHAs permanently red and
    `gh-merge-approved` refusing every one of them with RUNS-NOT-SUCCESS.

    So a workflow that fires on EVERY pull request must not serialise on a single
    static group. Either give the group a per-PR key, or stop firing on every PR.
    """
    offenders = []
    for name, doc in _pr_triggered_workflows():
        triggers = doc.get("on", doc.get(True, {})) or {}
        pr = triggers.get("pull_request") or {}
        # A `types:` filter means it fires on chosen events, not on every push to
        # every open PR, so it cannot fill the queue on its own.
        if isinstance(pr, dict) and pr.get("types"):
            continue
        group = str((doc.get("concurrency") or {}).get("group") or "")
        if not group:
            continue
        if "${{" not in group:
            offenders.append(f"{name} (group {group!r} is the same for every PR)")
    assert not offenders, (
        "a workflow fires on every pull request and serialises on one static "
        "concurrency group; the queue holds a single pending run, so with more than "
        "two open PRs GitHub cancels the displaced one and the wrapper then refuses "
        "that PR:\n" + "\n".join(offenders)
    )


# ── every job's runner comes from a repo variable, defaulting to its self-hosted lane ──
# The repo left GitHub-hosted runners in a0d2d1af (2026-08-28) for want of
# purchased minutes, and a self-hosted runner has no job time limit of its own:
# GitHub's 360-minute ceiling is a hosted-runner property, so a job that hangs
# here holds its runner until a human notices. There are two `quick` runners and
# two `heavy` ones on one 12-core box serving every repo in the org, so one
# wedged job is a real capacity loss -- drift-sentinel.yml alone sat `cancelled`
# for 6h on 2026-09-08 and 24h on 2026-09-07 for a job whose 57 recorded runs
# never exceeded 24 seconds.
#
# Once the repo is public every runner group refuses it, so no self-hosted job
# would ever start. The cut-over is a switch, not a rewrite: each job reads
# `vars.HM_RUNNER` (the heavy lane) or `vars.HM_RUNNER_QUICK` (the quick lane), a JSON
# string or array, and falls back to the named self-hosted lane while the variable
# is unset. The lane label stays in the fallback because a bare `self-hosted`
# matches by superset -- including wsl2-runner, reserved (label `gms-video`) for the
# 25-30 minute GoMoveShift video suite.
HOSTED_RUNNER_PREFIXES = ("ubuntu", "macos", "windows")

RUNNER_VARS = {"heavy": "HM_RUNNER", "quick": "HM_RUNNER_QUICK"}


def _runner_expr(lane):
    return "${{ fromJSON(vars.%s || '[\"self-hosted\",\"%s\"]') }}" % (RUNNER_VARS[lane], lane)


# The lane each job has always asked for; the unset-variable default must stay exactly this.
EXPECTED_LANE = {
    ("deploy-production.yml", "build-validate-deploy"): "heavy",
    ("deploy-staging.yml", "build-deploy"): "heavy",
    ("drift-sentinel.yml", "drift-sentinel"): "quick",
    ("drift-sentinel.yml", "product-drift"): "quick",
    ("pr-ci.yml", "scope"): "quick",
    ("pr-ci.yml", "pr-ci"): "heavy",
    ("pr-ci.yml", "site-audit"): "quick",
    ("pr-ci.yml", "result"): "quick",
    ("product-freshness.yml", "check"): "quick",
    ("product-sync.yml", "sync"): "quick",
    ("rigscore-facts-sync.yml", "sync"): "quick",
}

# The two jobs that pick `ubuntu-latest` for the site/skip tiers keep that condition; only
# the self-hosted fallback arm reads the variable.
PR_CI_JOB = ("pr-ci.yml", "pr-ci")
# The browser/link audits run in their own job, on the same hosted tiers; the self-hosted side
# is the idle `quick` lane, never `heavy`.
SITE_AUDIT_JOB = ("pr-ci.yml", "site-audit")
_TIERED = (
    "${{ contains(fromJSON('[\"site\", \"skip\"]'), needs.scope.outputs.qcm_scope) "
    "&& vars.HM_PR_CI_RUNNER != 'self-hosted' && 'ubuntu-latest' "
    "|| fromJSON(vars.%s || '[\"self-hosted\",\"%s\"]') }}"
)
SITE_AUDIT_RUNS_ON = _TIERED % ("HM_RUNNER_QUICK", "quick")
PR_CI_RUNS_ON = _TIERED % ("HM_RUNNER", "heavy")


def _workflow_jobs():
    """(workflow file, job id, job dict) for every job this repo declares."""
    out = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            doc = yaml.safe_load(fh) or {}
        for job_id, job in (doc.get("jobs") or {}).items():
            if isinstance(job, dict):
                out.append((name, job_id, job))
    return out


def _expected_runs_on(name, job_id):
    if (name, job_id) == PR_CI_JOB:
        return PR_CI_RUNS_ON
    if (name, job_id) == SITE_AUDIT_JOB:
        return SITE_AUDIT_RUNS_ON
    lane = EXPECTED_LANE.get((name, job_id))
    return _runner_expr(lane) if lane else None


def test_every_job_runs_on_the_runner_variable():
    """Every job's `runs-on` is the exact variable form for its lane (or the pinned tiered
    form on pr-ci and site-audit). A hard-coded label, a hosted image, a bare `self-hosted`
    or a job nobody classified fails."""
    jobs = _workflow_jobs()
    assert jobs, "no workflow declares a job; this test is checking nothing"
    offenders = []
    for name, job_id, job in jobs:
        runs_on = job.get("runs-on")
        want = _expected_runs_on(name, job_id)
        if runs_on is None:
            offenders.append(f"{name}:{job_id} declares no runs-on")
        elif want is None:
            offenders.append(f"{name}:{job_id} is not in EXPECTED_LANE; name its lane there")
        elif runs_on != want:
            offenders.append(f"{name}:{job_id} runs-on {runs_on!r} is not {want!r}")
    assert not offenders, (
        "every job must read its runner from HM_RUNNER / HM_RUNNER_QUICK:\n" + "\n".join(offenders)
    )


def test_unset_runner_variable_resolves_to_the_same_self_hosted_labels_as_before():
    for (name, job_id), lane in EXPECTED_LANE.items():
        job = next(j for n, i, j in _workflow_jobs() if (n, i) == (name, job_id))
        fallback = _eval_pr_ci_runs_on(job["runs-on"], "full")
        assert fallback == ["self-hosted", lane], (name, job_id, fallback)
        assert not any(str(x).lower().startswith(HOSTED_RUNNER_PREFIXES) for x in fallback)


def test_set_runner_variable_replaces_the_lane_everywhere():
    for (name, job_id), lane in EXPECTED_LANE.items():
        job = next(j for n, i, j in _workflow_jobs() if (n, i) == (name, job_id))
        got = _eval_pr_ci_runs_on(job["runs-on"], "full", **{RUNNER_VARS[lane].lower(): '"ubuntu-latest"'})
        assert got == "ubuntu-latest", (name, job_id, got)
        other = "heavy" if lane == "quick" else "quick"
        # the other lane's variable must not move this job
        got = _eval_pr_ci_runs_on(job["runs-on"], "full", **{RUNNER_VARS[other].lower(): '"ubuntu-latest"'})
        assert got == ["self-hosted", lane], (name, job_id, got)


def test_no_workflow_hard_codes_a_self_hosted_runs_on():
    """The labels live only in the variable's fallback, so a copy-pasted `runs-on: [self-hosted, ...]`
    cannot reintroduce a job the cut-over leaves stranded."""
    offenders = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if line.lstrip().startswith("#"):
                    continue
                if re.search(r"runs-on:\s*\[?\s*['\"]?self-hosted", line) or "fromJSON('[\"self-hosted\"" in line:
                    offenders.append(f"{name}:{lineno}: {line.strip()}")
    assert not offenders, "hard-coded self-hosted runs-on:\n" + "\n".join(offenders)


def test_every_job_bounds_its_own_runtime():
    """`timeout-minutes` is the only thing that ends a hung job on a self-hosted runner.
    Pick a value from the job's observed duration, not a default."""
    jobs = _workflow_jobs()
    assert jobs, "no workflow declares a job; this test is checking nothing"
    offenders = [
        f"{name}:{job_id}"
        for name, job_id, job in jobs
        if not isinstance(job.get("timeout-minutes"), int)
    ]
    assert not offenders, (
        "a job declares no integer timeout-minutes, so nothing stops it holding a "
        "shared runner indefinitely:\n" + "\n".join(offenders)
    )


def test_pr_ci_job_timeout_clears_the_slowest_green_run():
    """PR CI's cap is set from the job's measured duration, with room above the
    slowest green run, and stays bounded so a hung job cannot hold a heavy runner
    for hours.

    The cap was 30 minutes on a comment that still said "p50 8m52s, max 11m4s".
    The job had grown past that: over the 60 runs before 2026-10-06 4:00 PM ET
    (job started_at to completed_at, queue time excluded) a green job took 17.7 min
    at the median, 25.7 at p90 and 28.1 at the worst, and five runs that night and
    day were cancelled at 30.1-30.4 min mid-Lighthouse or mid-node with every test
    green -- #699's run 37515824991 among them. A cap within 7% of the slowest
    green run fails healthy runs on a loaded box; 1.5x the worst observed keeps a
    real hang bounded and a slow run alive.

    Two days later the 45 it was raised to had the same fault. Over the 60 runs
    completed before 2026-10-08 10:14 AM ET, measured the same way, the 28 green
    jobs took 27.9 min at the median, 35.8 at p90 and 43.0 at the worst (1.05x
    under a 45 cap), and nine runs were cancelled at 45.3-45.7 min -- #759's run
    37715513309 among them, cancelled in node --test after two preview tests that
    take 3-8 s on a quiet box took 349 s and 656 s on a loaded one.

    The upper bound used to be "under 60, GitHub cancels at 60 anyway". That was
    never measured and is false here: run 37642869684's job ran 107.9 min. 90 is
    this repo's own bound on how long a hang may hold a shared heavy runner."""
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    cap = doc["jobs"]["pr-ci"]["timeout-minutes"]
    slowest_green_minutes = 43.0
    assert cap >= slowest_green_minutes * 1.5, (
        f"pr-ci timeout-minutes is {cap}, under 1.5x the slowest green job "
        f"({slowest_green_minutes} min); a loaded box cancels healthy runs"
    )
    assert cap <= 90, (
        f"pr-ci timeout-minutes is {cap}; past 90 a hung job holds a shared heavy "
        "runner longer than this repo allows"
    )


# A path under the runner account's home, and the two ways a line can put
# something there: a command that creates or moves a file, or a redirection.
# Naming $HOME is not itself the offence -- a step that REMOVES a stranded
# directory has to name it, and so does a comparison guarding that removal.
# Matching every mention flagged `[ "$dir" = "$HOME/$name" ]`, which writes
# nothing, so the check would have forced the cleanup steps to lie about what
# they touch.
_HOME_PATH = r"(\$HOME|\$\{HOME\}|~)/"
_PLACES_A_FILE = re.compile(
    # a command that creates, copies, moves, links or unpacks into home
    r"\b(mkdir|mv|cp|install|ln|touch|tar|unzip|curl|wget|git\s+clone)\b.*" + _HOME_PATH
    # or a redirection into home
    + r"|>>?\s*\"?" + _HOME_PATH
    # or home put on PATH for later steps, which is how a shared binary gets run
    + r"|" + _HOME_PATH + r"[^\s\"']*\"?\s*>>\s*\"?\$\{?GITHUB_PATH"
)


def _home_installs():
    """Every workflow line that puts a file under the runner account's home directory."""
    found = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS_DIR, name)
        with open(path, encoding="utf-8") as fh:
            for number, line in enumerate(fh, start=1):
                bare = line.strip()
                if bare.startswith("#") or not _PLACES_A_FILE.search(bare):
                    continue
                found.append(f"{name}:{number}: {bare}")
    return found


def test_no_workflow_installs_a_tool_into_the_shared_home():
    """The runners are two processes under ONE user account on one box, so $HOME is
    shared mutable state between concurrent jobs -- it is not per-job scratch.

    2026-09-13: two PR CI jobs raced $HOME/.local/bin/htmltest. One exec'd the binary
    while the other was still extracting it over the top, and the link-check step died
    with `Text file busy` (exit 126) on a branch with nothing wrong with it.

    Serialising the jobs would hide this and cost every PR its wall-clock; the fix is
    to stop sharing the file. $RUNNER_TEMP is the runner's own scratch directory and
    is wiped between jobs, so two jobs cannot see each other's copy at all. This test
    asks for the property directly -- no workflow writes a tool into home -- rather
    than for the absence of the one error message, which would go quiet the next time
    a different tool is installed the same way.
    """
    offenders = _home_installs()
    assert not offenders, (
        "a workflow puts a file under the shared runner home; two concurrent jobs "
        "share that account, so one can overwrite a file the other is executing "
        "(`Text file busy`). Install into \"$RUNNER_TEMP\" instead:\n"
        + "\n".join(offenders)
    )


# Actions that install a tool into the runner ACCOUNT's home rather than into
# per-job scratch, and the path each one writes. Verified by reading the action's
# source and by listing the runner account's home on 2026-09-13.
#
# This list must grow when a new `uses:` step installs a tool. There is no way to
# ask a third-party action statically where it puts things, so the check for a new
# action is manual: read what it does with the home directory (`os.homedir()`,
# `$HOME`, `~`), or run it once and look at what appeared under the account's home.
HOME_WRITING_ACTIONS = {
    "peaceiris/actions-hugo": "$HOME/actions_hugo/bin/hugo",
}


def _home_writing_action_steps():
    """Every `uses:` line naming an action from HOME_WRITING_ACTIONS."""
    found = []
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS_DIR, name)
        with open(path, encoding="utf-8") as fh:
            for number, line in enumerate(fh, start=1):
                bare = line.strip()
                if bare.startswith("#") or "uses:" not in bare:
                    continue
                for action, writes in HOME_WRITING_ACTIONS.items():
                    if action in bare:
                        found.append(f"{name}:{number}: {action} installs to {writes}")
    return found


def test_no_workflow_installs_a_tool_via_a_home_writing_action():
    """test_no_workflow_installs_a_tool_into_the_shared_home reads `run:` lines and
    cannot see what a `uses:` step does. The largest shared-home install in this repo
    was exactly that: peaceiris/actions-hugo puts the binary in $HOME/actions_hugo/bin,
    and three workflows called it.

    Same failure as the htmltest one that produced `Text file busy` (exit 126) on
    2026-09-13: the runners are processes under ONE account, so two concurrent jobs
    extract Hugo over the path the other may be executing. The action takes no input
    that moves the install off the shared home.

    The fix is the pattern this repo already uses for htmltest -- download the pinned
    release, verify its SHA256, extract into "$RUNNER_TEMP/bin" -- which also removes
    a third-party action from the path that builds the production site.
    """
    offenders = _home_writing_action_steps()
    assert not offenders, (
        "a workflow installs a tool through an action that writes into the shared "
        "runner home; two concurrent jobs share that account, so one can overwrite a "
        "binary the other is executing (`Text file busy`). Install the pinned release "
        'into "$RUNNER_TEMP/bin" instead, as the htmltest steps do:\n'
        + "\n".join(offenders)
    )


def _hugo_pins():
    """Every workflow that installs Hugo, mapped to the (version, checksum) it pins."""
    out = {}
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            text = fh.read()
        version = re.search(r"^\s*HUGO_VERSION:\s*'?\"?([0-9.]+)'?\"?", text, re.M)
        if not version:
            continue
        checksum = re.search(r"^\s*HUGO_SHA256:\s*'?\"?([0-9a-f]{64})'?\"?", text, re.M)
        out[name] = (version.group(1), checksum.group(1) if checksum else None)
    return out


def test_every_workflow_pins_the_same_hugo_version_and_checksum():
    """Hugo is downloaded, not installed by an action, so each workflow carries the
    version AND the SHA256 of the tarball that version serves. Three copies of a pair
    that must agree is exactly the shape that drifts: bump the version in one file and
    the download either fails the checksum (loud, fine) or -- if the checksum moved and
    the version did not -- the gates build the site with different Hugos, which is how
    the Node 20/22 split let a commit pass PR CI and fail its own deploy.

    A missing checksum is the worse half: `sha256sum -c` against an empty string fails,
    so the workflow breaks at run time rather than here.
    """
    pins = _hugo_pins()
    assert pins, "no workflow pins a Hugo version; this test is checking nothing"
    missing = [name for name, (_, checksum) in pins.items() if checksum is None]
    assert not missing, (
        "a workflow sets HUGO_VERSION with no HUGO_SHA256 beside it, so its download "
        "cannot be verified: " + ", ".join(missing)
    )
    distinct = set(pins.values())
    assert len(distinct) == 1, (
        "workflows disagree about the Hugo version or its checksum, so a PR can be "
        "green and its deploy red:\n"
        + "\n".join(f"{name}: {pin}" for name, pin in pins.items())
    )


def _gh_pages_publishers():
    """Every workflow that publishes with actions-gh-pages, and whether it reclaims
    the staging directory that action strands in the shared runner home."""
    out = {}
    for name in sorted(os.listdir(WORKFLOWS_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS_DIR, name)
        with open(path, encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        steps = [s for job in (doc.get("jobs") or {}).values() for s in (job.get("steps") or [])]
        if not any("actions-gh-pages" in (s.get("uses") or "") for s in steps):
            continue
        reclaims = [
            s for s in steps if "actions_github_pages_" in (s.get("run") or "")
        ]
        out[name] = reclaims
    return out


def test_every_gh_pages_publisher_reclaims_its_staging_dir():
    """peaceiris/actions-gh-pages clones the publish branch into
    $HOME/actions_github_pages_<epoch> and never removes it. The runners are
    processes under ONE account, so that directory is never anyone's to clean:
    the gomoveshift site stranded 12 GB across fifteen of them by 2026-07-27, and
    this repo had three (33 MB) on 2026-09-13 from a single day of deploys.

    The reclaim step must run under `if: always()` -- a cancelled or failed deploy
    strands the directory exactly the same way, and those are the runs most likely
    to leave a half-written one behind.

    _ops/host-cleanup.sh in the workspaces repo sweeps the same glob on a timer and
    owns the retention rule; this test is about not creating the backlog in the
    first place, which is the difference between a workflow that cleans up after
    itself and one that leans on a cron job somebody else maintains.
    """
    publishers = _gh_pages_publishers()
    assert publishers, "no workflow publishes with actions-gh-pages; this test is checking nothing"

    missing = [name for name, reclaims in publishers.items() if not reclaims]
    assert not missing, (
        "a workflow publishes with actions-gh-pages and never removes the "
        "$HOME/actions_github_pages_* directory it leaves in the shared runner "
        "home: " + ", ".join(missing)
    )

    unconditional = [
        f"{name}: {step.get('name') or 'unnamed step'}"
        for name, reclaims in publishers.items()
        for step in reclaims
        if str(step.get("if", "")).strip() != "always()"
    ]
    assert not unconditional, (
        "a reclaim step does not run under `if: always()`, so a failed or cancelled "
        "deploy still strands its staging directory:\n" + "\n".join(unconditional)
    )


# Where htmltest keeps its external-link cache (refcache.json) -- .htmltest.yml
# leaves OutputDir at htmltest's default -- and the directory the workflows carry
# from one run to the next.
HTMLTEST_CACHE_DIR = "tmp/.htmltest"


def _uses(step):
    return str(step.get("uses") or "")


def _runs_htmltest(step):
    """True for a step whose script runs htmltest, not one that only installs it."""
    lines = str(step.get("run") or "").splitlines()
    return any(re.match(r"\s*htmltest(\s|$)", line) for line in lines)


def test_htmltest_cache_is_saved_after_a_red_link_check():
    """The combined actions/cache action saves in a post step that its action.yml
    runs only on success (`post-if: success()`; the `save-always` input that once
    got round that is deprecated). So a run that failed its link check never kept
    what it had learned, and the next run of the PR started cold: hm#665's fifth
    red run (36995804363, 2026-10-02) failed only at htmltest, on six 503s from
    github.com, and the caches API listed no cache at all for its ref
    (`actions/caches?ref=refs/pull/665/merge`). Every retrigger fetched every
    external link again, from the host that had just refused them.

    Saving after a red check is safe: htmltest writes refcache.json once the
    documents are tested, whatever they turned up (htmltest/htmltest.go,
    `WriteStore`), and reuses only results cached with an OK status
    (htmltest/check-link.go, `statusCodeValid`), so a failure is fetched again
    next time rather than repeated from the cache.

    A cache key can be written only once, and a re-run of the same commit keeps
    `github.sha`, so the save key carries the run id and attempt, which no other
    run shares; restore-keys then finds the newest cache under the shared prefix.
    """
    jobs = []
    for name, job_id, job in _workflow_jobs():
        steps = job.get("steps") or []
        if any((step.get("with") or {}).get("path") == HTMLTEST_CACHE_DIR for step in steps):
            jobs.append((f"{name} job {job_id}", steps))
    assert jobs, f"no workflow job caches {HTMLTEST_CACHE_DIR}; this test is checking nothing"

    problems = []
    for where, steps in jobs:
        cached = [
            (i, step) for i, step in enumerate(steps)
            if (step.get("with") or {}).get("path") == HTMLTEST_CACHE_DIR
        ]
        if any(_uses(step).startswith("actions/cache@") for _, step in cached):
            problems.append(
                f"{where}: caches {HTMLTEST_CACHE_DIR} with actions/cache, "
                "which saves only when the job succeeds"
            )
        checks = [i for i, step in enumerate(steps) if _runs_htmltest(step)]
        if not checks:
            problems.append(f"{where}: caches {HTMLTEST_CACHE_DIR} but runs no htmltest step")
            continue
        restores = [s for i, s in cached if _uses(s).startswith("actions/cache/restore@")
                    and i < checks[0]]
        if not restores:
            problems.append(f"{where}: no actions/cache/restore step before the link check")
        saves = [s for i, s in cached if _uses(s).startswith("actions/cache/save@")
                 and i > checks[-1]]
        if not saves:
            problems.append(f"{where}: no actions/cache/save step after the link check")
        prefixes = [
            line.strip()
            for step in restores
            for line in str((step.get("with") or {}).get("restore-keys") or "").splitlines()
            if line.strip()
        ]
        for step in saves:
            label = f"{where}: {step.get('name') or 'unnamed save step'}"
            cond = str(step.get("if") or "")
            if "always()" not in cond and "!cancelled()" not in cond:
                problems.append(
                    f"{label}: its `if` names neither always() nor !cancelled(), so it "
                    "runs only after success, and a red link check skips it"
                )
            key = str((step.get("with") or {}).get("key") or "")
            if "github.run_id" not in key or "github.run_attempt" not in key:
                problems.append(
                    f"{label}: key {key!r} is not new on every run attempt, and a "
                    "cache key can be written only once"
                )
            if not any(key.startswith(prefix) for prefix in prefixes):
                problems.append(
                    f"{label}: key {key!r} starts with none of the restore-keys "
                    f"{prefixes}, so no later run restores it"
                )
    assert not problems, (
        "the htmltest link cache is not kept after a red link check:\n" + "\n".join(problems)
    )


GITHUB_LINK_CHECKER = "scripts/qcm/check-github-links.mjs"


def test_github_links_are_checked_through_the_api_not_page_views():
    """github.com rate-limits page views per IP, and the three self-hosted runners
    share one, so htmltest's fetch of every github.com link went red on 503
    "Unicorn!" pages for links that were fine (hm#665-#668, 2026-10-02; the same
    URL with a browser user agent got 429 "Rate limit"). .htmltest.yml ignores
    github.com, and every job that runs htmltest checks those links after it
    through the REST API, with the job's token. An ignore with no API step after
    it would stop checking github.com links at all.
    """
    problems = []
    patterns = [re.compile(p) for p in _htmltest_ignore_urls()]
    for url in ("https://github.com", "https://github.com/Back-Road-Creative/rigscore",
                "https://www.github.com/Back-Road-Creative"):
        if not any(p.search(url) for p in patterns):
            problems.append(f".htmltest.yml still fetches {url} as a page")
    if any(p.search("https://github.com.example/") for p in patterns):
        problems.append(".htmltest.yml ignores hosts that only start with github.com")
    if not os.path.isfile(os.path.join(REPO_ROOT, GITHUB_LINK_CHECKER)):
        problems.append(f"{GITHUB_LINK_CHECKER} is missing")

    jobs = 0
    for name, job_id, job in _workflow_jobs():
        steps = job.get("steps") or []
        checks = [i for i, step in enumerate(steps) if _runs_htmltest(step)]
        if not checks:
            continue
        jobs += 1
        api = [s for s in steps[checks[-1] + 1:]
               if f"node {GITHUB_LINK_CHECKER}" in str(s.get("run") or "")]
        if not api:
            problems.append(f"{name} job {job_id}: runs htmltest, which ignores github.com, "
                            f"and no later step runs {GITHUB_LINK_CHECKER}")
        for step in api:
            token = str((step.get("env") or {}).get("GITHUB_TOKEN") or "")
            if token not in ("${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"):
                problems.append(f"{name} job {job_id}: {step.get('name')}: GITHUB_TOKEN is "
                                f"{token!r}, not the job's token")
    assert jobs, "no workflow job runs htmltest; this test is checking nothing"
    assert not problems, (
        "github.com links are not checked through the GitHub API:\n" + "\n".join(problems)
    )


# --- deploy data budget: one page load, not the sum of every file -------------
#
# 2026-10-07: the per-state place shards (static/data/quiet-corners/places-<ST>.json,
# 53 files, ~1.5MB together, each fetched alone once the view reaches the regional
# zoom) pushed `du -sk public/data` to 6280KB against a 5120KB budget, and every
# production deploy from d70d47f5 onward failed while no page ever loaded more
# than one shard. The step is run here against built fixtures, so the budget it
# enforces is what one dashboard load can pull.

def _data_budget_step():
    path = os.path.join(REPO_ROOT, ".github", "workflows", "deploy-production.yml")
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    for job in doc["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == "Validate - Data payload budget":
                return step["run"]
    raise AssertionError("deploy-production.yml has no 'Validate - Data payload budget' step")


def _run_data_budget(tmp_path, files):
    """Lay `files` ({relative path: KB}) under <tmp>/public/data and run the step there."""
    import subprocess
    for rel, kb in files.items():
        target = tmp_path / "public" / "data" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"0" * (kb * 1024))
    return subprocess.run(["bash", "-c", _data_budget_step()], cwd=tmp_path,
                          capture_output=True, text=True)


def test_data_budget_counts_one_page_load_not_every_lazy_shard(tmp_path):
    # Master's real shape: ~4.5MB of always-loaded JSON plus 53 shards that sum
    # to ~1.5MB but load one state at a time. The old `du -sk` sum read 6000KB
    # and failed; one load pulls 4500KB plus a single shard.
    files = {"quiet-corners/counties.json": 4500}
    files.update({f"quiet-corners/places-{i:02d}.json": 28 for i in range(53)})
    res = _run_data_budget(tmp_path, files)
    assert res.returncode == 0, f"a page load of 4500KB + one 28KB shard was refused:\n{res.stdout}{res.stderr}"


def test_data_budget_still_refuses_an_always_loaded_file_over_budget(tmp_path):
    res = _run_data_budget(tmp_path, {"quiet-corners/counties.json": 5200})
    assert res.returncode != 0, f"5200KB of always-loaded data passed:\n{res.stdout}"


def test_data_budget_caps_each_lazy_shard(tmp_path):
    # The exclusion is not a loophole: a shard is one fetch, so it has its own cap.
    res = _run_data_budget(tmp_path, {"quiet-corners/counties.json": 100,
                                      "quiet-corners/places-CA.json": 200})
    assert res.returncode != 0, f"a 200KB shard passed the per-shard cap:\n{res.stdout}"


# 2026-10-07 (second time): the camera snapshot files
# (static/data/quiet-corners-maps/cameras/<provider>/<region>.json, 38 files, ~1.8MB
# together) are the same shape as the place shards: main.js reads cameras/index.json
# once, then each region file alone, only when its bbox meets the view. Master deploy
# run 37654249420 (#690's eight new feeds) failed at 5472KB against 5120KB while no
# page ever loaded more than the index and the regions in view. The index itself is
# one always-loaded read and stays in the sum.

def test_data_budget_counts_one_camera_region_not_every_feed(tmp_path):
    files = {"quiet-corners/counties.json": 5000,
             "quiet-corners-maps/cameras/index.json": 10}
    files.update({f"quiet-corners-maps/cameras/provider-{i:02d}/region.json": 48
                  for i in range(38)})
    res = _run_data_budget(tmp_path, files)
    assert res.returncode == 0, f"5010KB always-loaded + 38 lazy 48KB camera files was refused:\n{res.stdout}{res.stderr}"


def test_data_budget_still_counts_the_camera_index(tmp_path):
    # The index is read on every camera-layer load, so it is not a lazy file.
    res = _run_data_budget(tmp_path, {"quiet-corners/counties.json": 5100,
                                      "quiet-corners-maps/cameras/index.json": 40})
    assert res.returncode != 0, f"5140KB of always-loaded data (index included) passed:\n{res.stdout}"


def test_data_budget_caps_each_lazy_camera_file(tmp_path):
    # One region file is one fetch, so it has its own cap, like a place shard.
    res = _run_data_budget(tmp_path, {"quiet-corners/counties.json": 100,
                                      "quiet-corners-maps/cameras/va-vdot/va-vdot-va.json": 300})
    assert res.returncode != 0, f"a 300KB camera region file passed the per-file cap:\n{res.stdout}"


# QQA-12b: once Cloudflare serves this commit, a read-only browser check proves the
# live Quiet Corners pages work (scripts/qcm/live-smoke.mjs). It must come after the
# marker wait, or it probes the previous deploy; it must pin this commit's sha; and a
# failure must fail the job so "Create issue on failure" fires.

SMOKE_STEP = "Post-deploy browser smoke (Quiet Corners)"


def _deploy_steps():
    path = os.path.join(REPO_ROOT, ".github", "workflows", "deploy-production.yml")
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)["jobs"]["build-validate-deploy"]["steps"]


def test_post_deploy_smoke_runs_after_the_marker_wait():
    names = [s.get("name") for s in _deploy_steps()]
    assert SMOKE_STEP in names, f"deploy-production.yml has no '{SMOKE_STEP}' step"
    assert names.index(SMOKE_STEP) > names.index("Wait for Cloudflare deployment")
    assert names.index(SMOKE_STEP) < names.index("Create issue on failure")


def test_post_deploy_smoke_pins_this_commit_and_is_fatal():
    step = next(s for s in _deploy_steps() if s.get("name") == SMOKE_STEP)
    run = step["run"]
    assert step.get("if") == "github.ref == 'refs/heads/master'"
    assert "continue-on-error" not in step
    assert "node scripts/qcm/live-smoke.mjs" in run
    assert "--base-url https://headlessmode.com" in run
    assert '--expect-sha "${{ github.sha }}"' in run
    # An outside service (USGS, ArcGIS) erroring is not our deploy failing.
    assert "--tolerate-service-errors" in run
    assert "|| true" not in run and "exit 0" not in run.split("\n")[-1]
    assert step.get("timeout-minutes") and int(step["timeout-minutes"]) <= 30


# ── pr-ci placement: hosted for the site and skip tiers, self-hosted otherwise ──
def _eval_pr_ci_runs_on(expr, scope, runner_var="", hm_runner="", hm_runner_quick=""):
    """Evaluate a runs-on expression the way Actions does, for the shapes this repo uses:
    contains(fromJSON('[...]'), x), fromJSON(vars.X || '[...]'), `!=` and `&&` / `||` over
    strings and arrays. Only the pieces these expressions need; anything else raises rather
    than guessing."""
    import json
    import re

    body = expr.strip()
    assert body.startswith("${{") and body.endswith("}}"), body
    body = body[3:-2].strip()
    body = re.sub(
        r"contains\(fromJSON\('([^']*)'\),\s*needs\.scope\.outputs\.qcm_scope\)",
        lambda m: repr(scope.lower() in [x.lower() for x in json.loads(m.group(1))]),
        body,
    )
    body = body.replace("vars.HM_PR_CI_RUNNER", repr(runner_var))
    body = body.replace("vars.HM_RUNNER_QUICK", repr(hm_runner_quick))
    body = body.replace("vars.HM_RUNNER", repr(hm_runner))
    body = body.replace("fromJSON(", "J(")
    body = body.replace("&&", " and ").replace("||", " or ")
    return eval(body, {"__builtins__": {}}, {"J": json.loads})  # noqa: S307 - literal from the repo


def _pr_ci_job():
    for name, job_id, job in _workflow_jobs():
        if (name, job_id) == PR_CI_JOB:
            return job
    raise AssertionError("pr-ci.yml has no pr-ci job")


def test_pr_ci_runner_tiers_use_exactly_the_pinned_expression():
    assert _pr_ci_job().get("runs-on") == PR_CI_RUNS_ON


def test_pr_ci_runner_site_and_skip_go_hosted_everything_else_self_hosted():
    expr = _pr_ci_job()["runs-on"]
    assert _eval_pr_ci_runs_on(expr, "site") == "ubuntu-latest"
    assert _eval_pr_ci_runs_on(expr, "skip") == "ubuntu-latest"
    heavy = ["self-hosted", "heavy"]
    for scope in ("full", "", "bogus", "SITE-ish", "narrow"):
        assert _eval_pr_ci_runs_on(expr, scope) == heavy, scope


def test_pr_ci_runner_variable_forces_every_tier_back_to_self_hosted():
    expr = _pr_ci_job()["runs-on"]
    for scope in ("site", "skip", "full", ""):
        assert _eval_pr_ci_runs_on(expr, scope, "self-hosted") == ["self-hosted", "heavy"], scope


def test_runner_guard_still_rejects_bare_hosted_labels(tmp_path, monkeypatch):
    """The exemption is for the exact expression on pr-ci only."""
    def run(files):
        for old in tmp_path.iterdir():
            old.unlink()
        for fname, text in files.items():
            (tmp_path / fname).write_text(text, encoding="utf-8")
        monkeypatch.setitem(globals(), "WORKFLOWS_DIR", str(tmp_path))
        try:
            test_every_job_runs_on_the_runner_variable()
        except AssertionError as exc:
            return str(exc)
        return None

    bare = "jobs:\n  pr-ci:\n    runs-on: ubuntu-latest\n    steps: []\n"
    assert "ubuntu-latest" in run({"pr-ci.yml": bare})
    other = "jobs:\n  scope:\n    runs-on: ubuntu-latest\n    steps: []\n"
    assert "ubuntu-latest" in run({"pr-ci.yml": other})
    tweaked = PR_CI_RUNS_ON.replace('"skip"', '"skip", "full"')
    mutated = "jobs:\n  pr-ci:\n    runs-on: %s\n    steps: []\n" % ("'" + tweaked.replace("'", "''") + "'")
    assert run({"pr-ci.yml": mutated}) is not None
    deploy = "jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n"
    assert run({"deploy-production.yml": deploy}) is not None
    # the exact expression on pr-ci.yml:pr-ci passes
    exact = "jobs:\n  pr-ci:\n    runs-on: %s\n    steps: []\n" % ("'" + PR_CI_RUNS_ON.replace("'", "''") + "'")
    assert run({"pr-ci.yml": exact}) is None
    # and the same expression on any other job or file does not
    assert run({"pr-ci.yml": exact.replace("pr-ci:", "other:")}) is not None


def test_deploy_production_defaults_to_self_hosted_heavy():
    with open(os.path.join(WORKFLOWS_DIR, "deploy-production.yml"), encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    for job_id, job in doc["jobs"].items():
        assert job["runs-on"] == _runner_expr("heavy"), f"deploy-production.yml:{job_id}"
        assert _eval_pr_ci_runs_on(job["runs-on"], "full") == ["self-hosted", "heavy"]


def test_pr_ci_hosted_chrome_step_runs_only_on_a_hosted_runner():
    steps = _pr_ci_job()["steps"]
    hosted = [s for s in steps if "github-hosted" in str(s.get("if", ""))]
    assert len(hosted) == 1, "exactly one hosted-only Chrome step"
    step = hosted[0]
    assert step["if"].strip() == "runner.environment == 'github-hosted'"
    assert "GITHUB_ENV" in step["run"] and "google-chrome" in step["run"]
    # a missing browser fails the step rather than leaving a CHROME_PATH that names nothing
    assert "exit 1" in step["run"]
    # self-hosted keeps the snap path from the workflow env, which verify-worktree.sh reads
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        assert "CHROME_PATH: '/snap/bin/chromium'" in fh.read()
    # it comes before every step that launches a browser
    names = [s.get("name", "") for s in steps]
    assert names.index(step["name"]) < names.index("Field Maps engine + script unit tests (node --test)")


def _chrome_steps(doc, job_id):
    return [s for s in doc["jobs"][job_id]["steps"] if "google-chrome" in str(s.get("run", ""))]


def test_every_job_that_drives_a_browser_gets_hosted_chrome_before_its_first_use():
    """The snap Chromium path in the workflow env exists only on the self-hosted box. Each
    job that launches a browser swaps in the hosted image's Chrome, hosted runs only, and
    before the first step that needs it."""
    first_browser_step = {
        ("pr-ci.yml", "pr-ci"): "Field Maps engine + script unit tests (node --test)",
        ("pr-ci.yml", "site-audit"): "Validate accessibility (pa11y-ci, WCAG2AA)",
        ("deploy-production.yml", "build-validate-deploy"): "Field Maps engine (node --test)",
    }
    for (name, job_id), first in first_browser_step.items():
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        chrome = _chrome_steps(doc, job_id)
        assert len(chrome) == 1, f"{name}:{job_id} needs exactly one hosted Chrome step"
        step = chrome[0]
        assert step["if"].strip() == "runner.environment == 'github-hosted'", (name, job_id)
        assert "GITHUB_ENV" in step["run"] and "exit 1" in step["run"], (name, job_id)
        names = _step_names(doc["jobs"][job_id])
        assert names.index(step["name"]) < names.index(first), (name, job_id)
        with open(os.path.join(WORKFLOWS_DIR, name), encoding="utf-8") as fh:
            assert "CHROME_PATH: '/snap/bin/chromium'" in fh.read(), name


def test_draft_pull_requests_do_not_start_a_build():
    """A draft burns a heavy build for a PR that cannot merge; `ready_for_review` starts it.
    All four jobs skip together, so `result` (which fails on a skipped needed job) stays quiet."""
    doc = _pr_ci_doc()
    trigger = doc.get("on", doc.get(True)) or {}
    assert "ready_for_review" in trigger["pull_request"]["types"]
    for job in ("scope", "pr-ci", "site-audit", "result"):
        cond = str(doc["jobs"][job].get("if") or "")
        assert "github.event.pull_request.draft == false" in cond, f"{job}: {cond}"
        assert "github.event_name != 'pull_request' ||" in cond, f"{job} must not gate dispatch runs"


# -- pr-ci split: the browser/link audits run in site-audit, off the heavy runner --
AUDIT_STEP_MARKERS = (
    "Restore htmltest external-link cache",
    "Install htmltest",
    "Validate links (htmltest, internal + external)",
    "Save htmltest external-link cache",
    "Validate github.com links (GitHub API)",
    "Validate accessibility (pa11y-ci, WCAG2AA)",
    "Select Lighthouse URLs (tier from scope job)",
    "Run Lighthouse CI (against local build)",
)


def _pr_ci_doc():
    with open(os.path.join(WORKFLOWS_DIR, "pr-ci.yml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _step_names(job):
    return [str(s.get("name") or "") for s in job.get("steps") or []]


def test_site_audit_job_follows_pr_ci_and_inherits_its_skip_rules():
    jobs = _pr_ci_doc()["jobs"]
    audit = jobs.get("site-audit")
    assert audit is not None, "pr-ci.yml has no site-audit job"
    needs = audit["needs"]
    needs = [needs] if isinstance(needs, str) else needs
    assert "pr-ci" in needs and "scope" in needs, needs
    assert audit["if"] == jobs["pr-ci"]["if"], "site-audit must skip exactly when pr-ci skips"
    assert isinstance(audit.get("timeout-minutes"), int)


def test_browser_and_link_audits_run_in_site_audit_not_pr_ci():
    jobs = _pr_ci_doc()["jobs"]
    audit_names, build_names = _step_names(jobs["site-audit"]), _step_names(jobs["pr-ci"])
    for marker in AUDIT_STEP_MARKERS:
        assert marker in audit_names, f"site-audit lacks the step {marker!r}"
        assert marker not in build_names, f"pr-ci still runs the step {marker!r}"
    for job in ("site-audit",):
        text = yaml.safe_dump(jobs[job]["steps"])
        assert "htmltest" in text and "pa11y-ci" in text and "lighthouse-ci-action" in text
    build_text = yaml.safe_dump(jobs["pr-ci"]["steps"])
    for needle in ("htmltest\n", "pa11y-ci --config", "lighthouse-ci-action", "check-github-links"):
        assert needle not in build_text, f"pr-ci still carries {needle!r}"
    # the build job keeps the Field Maps tests and hands the build over
    assert "Field Maps engine + script unit tests (node --test)" in build_names
    assert "Keep the J11 3D screenshots" in build_names


def test_pr_ci_hands_public_to_site_audit_as_a_one_day_artifact():
    jobs = _pr_ci_doc()["jobs"]
    ups = [s for s in jobs["pr-ci"]["steps"]
           if str(s.get("uses") or "").startswith("actions/upload-artifact@")
           and (s.get("with") or {}).get("name") == "site-public"]
    assert len(ups) == 1, "pr-ci must upload exactly one site-public artifact"
    assert ups[0]["with"]["path"] == "public"
    assert ups[0]["with"]["retention-days"] == 1
    downs = [s for s in jobs["site-audit"]["steps"]
             if str(s.get("uses") or "").startswith("actions/download-artifact@")]
    assert len(downs) == 1 and downs[0]["with"]["name"] == "site-public"
    assert downs[0]["with"]["path"] == "public"
    names = _step_names(jobs["site-audit"])
    assert names.index(downs[0]["name"]) < names.index("Validate links (htmltest, internal + external)")


def test_site_audit_runner_follows_pr_ci_hosted_tiers_and_never_takes_heavy():
    audit = _pr_ci_doc()["jobs"]["site-audit"]
    assert audit["runs-on"] == SITE_AUDIT_RUNS_ON
    expr = audit["runs-on"]
    assert _eval_pr_ci_runs_on(expr, "site") == "ubuntu-latest"
    assert _eval_pr_ci_runs_on(expr, "skip") == "ubuntu-latest"
    for scope in ("full", "", "bogus", "narrow"):
        assert _eval_pr_ci_runs_on(expr, scope) == ["self-hosted", "quick"], scope
    for scope in ("site", "skip", "full"):
        assert _eval_pr_ci_runs_on(expr, scope, "self-hosted") == ["self-hosted", "quick"], scope
    assert "heavy" not in expr


def test_site_audit_hosted_chrome_step_precedes_every_browser_step():
    steps = _pr_ci_doc()["jobs"]["site-audit"]["steps"]
    hosted = [s for s in steps if "github-hosted" in str(s.get("if", ""))]
    assert len(hosted) == 1 and "GITHUB_ENV" in hosted[0]["run"] and "exit 1" in hosted[0]["run"]
    names = _step_names({"steps": steps})
    assert names.index(hosted[0]["name"]) < names.index("Validate accessibility (pa11y-ci, WCAG2AA)")


def test_site_audit_probes_the_self_hosted_chromium_and_falls_back_to_chrome_for_testing():
    # wsl2-ci-1 runs its runner under NoNewPrivileges=yes, so the setuid snap-confine
    # cannot start /snap/bin/chromium there ("snap-confine is packaged without
    # necessary permissions", run 39684764854); the runners under the host's own user start it fine.
    # The step launch-probes the browser CHROME_PATH names and, when it cannot start,
    # installs Chrome for Testing into the runner's tool cache and repoints CHROME_PATH
    # for pa11y and Lighthouse. It never edits the runner.
    steps = _pr_ci_doc()["jobs"]["site-audit"]["steps"]
    probe = [s for s in steps if "self-hosted" in str(s.get("if", ""))]
    assert len(probe) == 1, "exactly one self-hosted browser probe step"
    step = probe[0]
    assert step["if"].strip() == "runner.environment == 'self-hosted'"
    run = step["run"]
    assert "--dump-dom about:blank" in run, "a real launch, not a path test"
    assert "@puppeteer/browsers install chrome" in run
    assert "RUNNER_TOOL_CACHE" in run, "the download is kept across runs"
    assert "GITHUB_ENV" in run and "exit 1" in run, "repoints CHROME_PATH; fails closed"
    names = _step_names({"steps": steps})
    assert names.index("Install dependencies") < names.index(step["name"])
    assert names.index(step["name"]) < names.index("Validate accessibility (pa11y-ci, WCAG2AA)")


def test_result_waits_for_all_three_jobs_and_keeps_its_check_name():
    doc = _pr_ci_doc()
    result = doc["jobs"]["result"]
    assert result["needs"] == ["scope", "pr-ci", "site-audit"]
    env = str(result["steps"][0]["env"]["RESULTS"])
    for job in ("scope", "pr-ci", "site-audit"):
        assert f"needs.{job}.result" in env
    assert "'PR CI result'" in result["name"]
    assert "'PR CI (build + validate)'" in doc["jobs"]["pr-ci"]["name"]
