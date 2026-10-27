---
title: "rigscore"
description: "Command-line checker for AI coding agent configuration: scores governance files, MCP configs and permissions, and flags where rules and settings disagree."
date: 2026-08-06
draft: false
tags: ["hygiene", "security", "ai", "cli", "open-source", "devtools", "reference", "supply-chain"]
---

rigscore is a command-line tool that checks how an AI coding agent is configured. It reads a project's governance documents (such as `CLAUDE.md` or `AGENTS.md`), MCP (Model Context Protocol) server configs, permissions, skill files, Docker settings and secrets handling, and compares what the project's rules say with what the configuration allows. For example, it flags a `CLAUDE.md` that forbids access to `/etc` while the MCP config mounts `/`. It covers the clients in the [supported-clients matrix](#supported-clients), including Claude Code, Cursor, Codex CLI and Gemini CLI.

A scan runs {{< rigscore-fact field="checkCount" >}} checks ({{< rigscore-fact field="scoredCount" >}} scored, {{< rigscore-fact field="advisoryCount" >}} advisory) and prints two independent 100-point grades, each A–F: **Hygiene** for security-relevant configuration and **Practice** for how the team sets up and governs its agents. A repo with no practice surface prints `Practice: n/a` instead of `0/100`.

## Install {#install}

Run this in a project directory (Node >= 20):

```bash
npx github:Back-Road-Creative/rigscore
```

Fetching the package is a network step. After that, a default scan reads local files, needs no account or token, and makes no network calls; `--online` and `--semantic` are opt-in exceptions, described under [network use](#network-use). Release notes: [github.com/Back-Road-Creative/rigscore/releases](https://github.com/Back-Road-Creative/rigscore/releases).

---

## Documentation

The manual is on this page:

- [Two scores](#two-scores), [network use](#network-use) and the [sample output](#sample-output)
- [What it checks](#what-it-checks): scored and advisory checks, [scoring](#scoring), the [Practice score](#practice-score) and the [compliance report](#compliance-report)
- [Fixing what it finds](#fix-what-it-finds) and [known limits](#known-limits)
- [CI integration](#ci-integration): GitHub Actions, SARIF, baselines, pins and exit codes
- The [command reference](#command-reference) and the [supported-clients matrix](#supported-clients)
- The [release-verification recipe](#verify-rigscore)

> **Scope.** rigscore measures configuration hygiene, not runtime security. It reads files on disk (governance docs, MCP configs, Docker settings, skill files, permissions) and scores what they say. It does not observe the running agent. Use it alongside a runtime scanner and source-level static analysis; see [known limits](#known-limits).

### Two scores {#two-scores}

Every scan prints **Hygiene** and [**Practice**](#practice-score), scored independently, so neither moves the other. The grade bands for both are under [Scoring](#scoring).

### Network use {#network-use}

A default scan of an installed copy makes no network calls and sends nothing off the machine. Four things involve the network or an outside process:

- **Installation.** `npx github:…` downloads the package from GitHub, and `npx` or `npm` may fetch its two runtime dependencies. The [Docker image](#docker-image) and the [release-verification](#verify-rigscore) commands also download from GHCR (GitHub Container Registry) and GitHub.
- **`--online`** opts in to outbound HTTP: probes of the sites you list under `sites` in `.rigscorerc.json`, lookups of the npm registry entries for your MCP server packages, and the official MCP registry (`registry.modelcontextprotocol.io`), whose response is cached under `~/.cache/rigscore/` for 24 hours and used to extend the typosquat check. `--refresh-mcp-registry` forces a refetch and implies `--online`. Scored checks still run without `--online`, but their online sub-checks are skipped.
- **`--semantic`** runs your own agent CLI as a local process (`claude -p` by default, or the command in `semantic.command`) once per MCP tool description. rigscore itself makes no API call and needs no API key, but each description is passed to that CLI, and what the CLI does with the text, including sending it to its model provider, is outside rigscore's control. See [Semantic tool-description judge](#semantic-tool-description-judge).
- **Local files.** A scan may write `.rigscore-state.json` (hashes of MCP server shapes), and `--record-score` writes `.rigscore-history.json`. Neither is sent anywhere.

### Sample output

{{< ascii-output >}}
  rigscore v{{< rigscore-fact field="version" >}}

  [X]   MCP server configuration  [mechanical]  CRITICAL "filesystem" mounts /
  [OK]  Cross-config coherence    [keyword]     governance matches config
  [ADV] Semantic tool judge       [pattern]     advisory — run with --semantic

  HYGIENE 78/100 (B)   ·   Practice 71/100 (B)
  Grade: B

  Each row's [mechanical] / [pattern] / [keyword] tag shows how its points
  are earned (see the legend below).
{{< /ascii-output >}}

### Why rigscore

- **Governance claims are checked against configuration.** The coherence check compares what your governance files say with what your configs allow, such as a `CLAUDE.md` that forbids `/etc` next to an MCP config that mounts `/`, or a "no shell" rule next to a shell server with filesystem access. It shares the heaviest scored weight (14 of 100, with MCP configuration), and a coherence CRITICAL costs an extra 10 points on top of zeroing its own sub-check.
- **A second axis.** [Practice](#practice-score) scores loop governance, spec goals, workflow maturity and sandbox posture. These checks carry zero Hygiene weight by default, so they do not change the Hygiene number unless a custom `weights:` map promotes one into the scored lane.
- **One scan covers many surfaces.** Instructions, permissions, MCP, skills, hooks, CI, Docker and environment files are read in a single run, which produces the Hygiene grade (with an embeddable badge) and the Practice score.

### Fix what it finds

`rigscore . --fix` dry-runs every auto-fixable issue — plus the starter packs that target your red checks — and writes nothing. `--fix --yes` applies the safe, file-level fixes to files you already have; `--fix --yes --install-packs` also scaffolds guard packs for the major AI clients wherever a check is red. To install a single pack on its own, run `rigscore init --<pack>`. The full flag ladder lives in the [command reference](#command-reference).

### What it checks

#### Scored checks ({{< rigscore-fact field="scoredCount" >}} · 100 points) {#scored-checks}

{{< rigscore-check-table kind="scored" >}}

AI-specific checks (MCP, coherence, skill files, governance docs) hold 48 of the 100 points; the rest cover secrets, container isolation, infrastructure, hygiene.

#### Advisory checks ({{< rigscore-fact field="advisoryCount" >}} · zero weight) {#advisory-checks}

Advisory checks carry zero Hygiene weight; several score on the Practice axis instead.

{{< rigscore-check-table kind="advisory" >}}

### Scoring

| Score | Grade | Meaning |
|-------|-------|---------|
| 90–100 | A | Strong hygiene posture |
| 75–89 | B | Good foundation, some gaps |
| 60–74 | C | Moderate risk, needs attention |
| 40–59 | D | Significant gaps |
| 0–39 | F | Critical issues, fix immediately |

- **CRITICAL** zeros out its sub-check; a coherence CRITICAL costs an extra 10 points.
- **WARNING** deducts 15 each (1 = 85, 2 = 70, 3 = 55); **INFO** deducts 2 each, floored at 50 with no WARNINGs.
- **PASS** / **SKIPPED**: no impact.

**Coverage scaling:** unscannable checks are marked N/A and their weight redistributed; the score scales by `min(1, W / 100)` for applicable weight `W`.

#### The Practice score {#practice-score}

Every scan prints a second 100-point axis. **Hygiene** asks *is this rig safe?* **Practice** asks *does this team drive its agents well?*

| Practice check | Weight |
|---|---|
| Loop governance | 25 |
| Spec goals | 20 |
| Workflow maturity | 20 |
| Sandbox posture | 15 |
| CI agent caps | 10 |
| Memory hygiene | 5 |
| AI disclosure | 5 |

Practice checks contribute zero to Hygiene. A repo with no practice surface prints `Practice: n/a`, not an unfair `0/100`; `--json` reports `practiceScore` (number or `null`). The coherence check and this second axis are covered in [Why rigscore](#why-rigscore).

#### Enforcement-grade labels

Each check's label shows *how* its points are earned; it is display-only.

- **`[mechanical]`** — deterministic inspection of config and file state against known-bad constants, file modes or structural rules; changing prose does not change the result, and it sees only what it has a rule for. {{< rigscore-fact field="enforcementGrades.mechanical" >}} of {{< rigscore-fact field="checkCount" >}}.
- **`[pattern]`** — regex or structural scan; encoded or obfuscated content can evade it. {{< rigscore-fact field="enforcementGrades.pattern" >}} of {{< rigscore-fact field="checkCount" >}}.
- **`[keyword]`** — phrase presence in governance prose, gameable by keyword-stuffing (see [known limits](#known-limits)). {{< rigscore-fact field="enforcementGrades.keyword" >}} of {{< rigscore-fact field="checkCount" >}}.

#### Scoring profiles

A profile is a weight map. Five ship built in:

| Profile | Use-case |
|---|---|
| `default` | Balanced AI dev environment audit |
| `minimal` | Smoke test — AI-moat checks only |
| `ci` | CI pipelines (identical to `default` today) |
| `home` | Single-user dev boxes — infra/docker/windows off |
| `monorepo` | Multi-project repos — hints `--recursive --depth 3` |

{{< cmd >}}npx github:Back-Road-Creative/rigscore --profile minimal{{< /cmd >}}

Resolution order: `--profile`, then project `.rigscorerc.json`, then `~/.rigscorerc.json`, then `default`. Custom `weights:` promote an advisory check into the scored lane (non-zero) or demote a scored one (`0`).

### Compliance report

`--report compliance` groups findings by framework control — deterministic text, diffable in CI or for an auditor:

{{< cmd >}}npx github:Back-Road-Creative/rigscore --report compliance .{{< /cmd >}}

| Framework | Status | Coverage |
|---|---|---|
| OWASP Top 10 for Agentic Applications 2026 | Final | full |
| OWASP MCP Top 10 | Beta (pilot) | partial |
| NIST AI RMF 1.0 | Final | full |
| EU AI Act — Regulation (EU) 2024/1689 | In force, phased | full |

This is a mapping of checks to framework controls, not a certification, audit result or statement of compliance. A check is listed under a control only where it produces evidence for it; controls no check supports print `NOT EVIDENCED`, and checks with no fitting control print `UNMAPPED`. "Full" coverage means every scored check is mapped, not that every control is satisfied. rigscore evidences technical controls in a repository; it cannot evidence your risk-management process, log retention or end-user disclosures. Muted findings (`suppress:` / `--ignore`) are disclosed by count and id. Not available with `--recursive`.

### Limitations {#known-limits}

rigscore checks whether configuration is present and well-formed; it does not enforce anything. Read this before using the score as a governance quality signal.

- **Semantic reversal bypasses keyword checks.** The governance checks (governance docs + coherence, 24 of the 100 scoring points) only confirm your file *mentions* concepts like "path restrictions"; stuffed headers over a body that dismantles them still pass. See `test/keyword-gaming.test.js` for the bypass list.
- **Injection detection is pattern-based.** Unicode-normalized patterns catch common prompt-injection; encoded payloads, rephrasings, and homoglyphs can evade them.
- **Config-shape pinning only, not runtime tool descriptions.** rigscore hashes each MCP server's *configured* shape — `{command, args, envKeys}` — and warns on change (CVE-2025-54136 / MCPoison class), but does **not** hash the tool descriptions a running server advertises. The `mcp-hash` / `mcp-pin` / `mcp-verify` workflow pins those operator-side.
- **Secret scanning covers named config files in the project root.** Use `--deep` for recursive source, or a dedicated git-history secret scanner for git history.
- **Point-in-time snapshots only.** No continuous monitoring, no git-history scan.
- **Score depends on project shape.** rigscore ships {{< rigscore-fact field="checkCount" >}} checks; an npm package legitimately sees most as N/A. rigscore itself is a package, not an agent workspace — no committed MCP config, no `.claude/skills/`, no per-client rule sets — so only a minority apply. See [Dogfooding](#dogfooding) for the exact self-score.

### Dogfooding

rigscore runs on rigscore in CI.

- **Self-score 37/100 (Grade F).** As an npm package only 10 of its {{< rigscore-fact field="checkCount" >}} apply (weight 46/100), the rest N/A.
- **CI threshold `--fail-under 30`.** The baseline (37) minus a 7-point buffer; the public default is 70.
- **`.rigscorerc.json` disables four checks** (`infrastructure-security`, `skill-coherence`, `workflow-maturity`, `agent-output-schemas`) needing artifacts rigscore doesn't ship.

### CI integration

#### GitHub Actions

```yaml
- uses: Back-Road-Creative/rigscore@v{{< rigscore-fact field="version" >}}
  with:
    fail-under: 70
    upload-sarif: true
```

Or run directly:

{{< cmd lang="yaml" >}}- run: npx github:Back-Road-Creative/rigscore --ci --fail-under 70{{< /cmd >}}

Pin to a released tag (the action rejects `@main`-style refs); tags through `v{{< rigscore-fact field="version" >}}` are available.

#### SARIF

rigscore emits SARIF v2.1.0: `npx github:Back-Road-Creative/rigscore --sarif > results.sarif`, uploaded via `github/codeql-action/upload-sarif`.

#### Baseline gate

Gate on *new* findings, not an absolute score: the first run writes the baseline; later runs report only findings not in it and exit 1 if any exist:

{{< cmd >}}npx github:Back-Road-Creative/rigscore --baseline .rigscore-baseline.json{{< /cmd >}}

Commit the baseline: the gate reads the HEAD copy, so a deleted or corrupt working-tree baseline fails closed. Refresh with `--baseline-refresh`.

#### State file and MCP-shape gate

With a repo-level `.mcp.json`, a scan writes `.rigscore-state.json`: a SHA-256 pin of each MCP server's `{command, args, envKeys}` shape (env **keys** only, never values). A changed pin flags a silent swap of a trusted server (the MCPoison class, CVE-2025-54136); an uncommitted pin detects nothing.

{{< cmd >}}npx github:Back-Road-Creative/rigscore --verify-state{{< /cmd >}}

`--verify-state` is the read-only CI gate: it reads the pin at HEAD (a fresh pin can't satisfy it) and exits 1 on drift, 2 if missing or corrupt, 0 if all match. `--no-state-write` skips the write on a borrowed checkout, flagging the lost coverage.

#### Runtime tool pinning

The state file above pins each MCP server's *configured* shape. The tool descriptions a *running* server advertises are pinned separately, on demand — rigscore never launches the server itself (running it would execute code from the server you are trying to vet), so it uses a print-and-paste workflow:

```bash
npx -y <mcp-server-package> | rigscore mcp-hash | xargs rigscore mcp-pin <server>   # pin
npx -y <mcp-server-package> | rigscore mcp-verify <server>                          # verify later
```

`rigscore mcp-hash` canonicalizes and hashes a `tools/list` JSON read from stdin; `mcp-pin` stores it in `.rigscore-state.json`; `mcp-verify` re-compares. Verify exits `0` on a match, `3` when nothing is pinned for that server, and `4` on drift — a tool description that silently changed under a trusted server (the CVE-2025-54136 rug-pull class). Each server also gets a zero-weight INFO during a normal scan showing whether its runtime hash is pinned.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | At or above `--fail-under` (baseline: no new findings) |
| `1` | Below `--fail-under`, or new findings vs baseline |
| `2` | Config error — bad `.rigscorerc.json`, unknown `--profile`, or corrupt baseline |
| `3` | `rigscore mcp-verify <server>` with no runtime hash pinned |
| `4` | `rigscore mcp-verify <server>` drift — the piped `tools/list` no longer matches the pinned runtime hash |

### Command reference {#command-reference}

Scoring, compliance mapping and CI gates are above; this section covers the working-session
commands and packaging.

#### Auto-fix and starter packs

`--fix` identifies safe, reversible remediations — and offers the starter packs that target your red checks. Consent is layered: dry run by default, `--yes` unlocks file-level edits to files you already have, `--install-packs` additionally allows scaffolding new files:

```bash
npx github:Back-Road-Creative/rigscore --fix                        # dry run: lists auto-fixes AND installable packs, writes nothing
npx github:Back-Road-Creative/rigscore --fix --yes                  # applies auto-fixes; packs are offered, not installed
npx github:Back-Road-Creative/rigscore --fix --yes --install-packs  # also installs the packs targeting your red checks
```

`--fix` never rewrites governance content, and a pack install never overwrites an existing file — it is reported `skipped (exists)` and left byte-for-byte alone. To install one specific pack, or overwrite deliberately:

```bash
npx github:Back-Road-Creative/rigscore init --list-packs             # what ships, and which checks each pack targets
npx github:Back-Road-Creative/rigscore init --<pack> [dir] [--force] # install one pack directly
```

##### The packs that ship

Seven guard packs ship with rigscore. Each targets a specific failing check:

| Pack | Turns green | What it installs |
|---|---|---|
| `guards` | Claude settings · git hooks | deny rules, an expiring permissions manifest, and a working pre-commit secret scan |
| `docs` | governance docs | one vendor-neutral `AGENTS.md` agent contract plus a `CLAUDE.md` that defers to it |
| `container` | Docker security · network exposure | a devcontainer with an egress-proxy allowlist — the agent reaches only the hosts you list |
| `cursor-guards` | sandbox posture | a narrow Cursor terminal/MCP allowlist with no auto-run wildcard |
| `codex-guards` | sandbox posture | a least-privilege Codex CLI baseline — always-prompt approvals, a workspace-write sandbox, network off |
| `gemini-guards` | sandbox posture | a Gemini CLI baseline where every tool call prompts instead of auto-approving edits or shell |
| `opencode-guards` | sandbox posture | an opencode ask/deny permission block so no shell, edit, or fetch auto-runs without approval |

##### Hardening an existing config

By default a pack install never touches a file you already have — an existing config is reported `skipped (exists)` and left byte-for-byte alone. To fold a pack's keys *into* an existing JSON or YAML config instead of scaffolding a new one, add a merge mode:

```bash
npx github:Back-Road-Creative/rigscore init --<pack> --<mode>   # <mode>: merge (alias: harden)
```

In merge mode, absent keys are added, arrays are unioned, and existing values, comments, and key order are all preserved — it is idempotent, so re-running changes nothing. Merge is mutually exclusive with `--force` (which overwrites); when both are supplied, merge wins.

#### Recursive / monorepo mode

`--recursive` discovers project subdirectories (any recognizable marker file: `package.json`, `pyproject.toml`, `Dockerfile`, `CLAUDE.md`, …) and scans each independently, four at a time. The overall score is the average across discovered projects; each project's own `.rigscorerc.json` is honored.

```bash
npx github:Back-Road-Creative/rigscore . --recursive
npx github:Back-Road-Creative/rigscore . -r --depth 2   # two levels, e.g. workspace/_active/svc-foo
```

#### Suppressing findings

Mute a finding by its stable ID via the flag or `.rigscorerc.json`:

```bash
npx github:Back-Road-Creative/rigscore --ignore "env-exposure/env-not-gitignored,skill-files/shell-exec"
```

```json
{ "suppress": ["env-exposure/env-not-gitignored"] }
```

##### Pattern forms

Each suppress entry is matched one of three ways (all case-insensitive):

- **Exact ID** — a full `<check-id>/<slug>` such as `env-exposure/env-not-gitignored`; a bare `<check-id>` such as `skill-files` mutes every finding from that check.
- **Glob** — any entry containing `*` is a glob against the finding ID: `skill-files/*` mutes that check's findings, `**/shell-exec` matches the slug across every check (`*` stays within a path segment, `**` spans `/`).
- **Regex** — an entry that begins `re:/…/` is a regular expression tested against both the finding ID and its title, e.g. `re:/inject|exfil/`.

A plain word that is neither an exact ID nor a glob falls back to a **case-insensitive substring match on the finding title** — handy, but broad: `token` mutes every finding whose title contains "token". Prefer an ID or a `re:/…/` form when you need precision.

Suppression is never silent: the terminal report, JSON (`suppressed: { count, ids }`), and SARIF all disclose how many findings were muted and which. IDs follow `<check-id>/<slug>`, are stable within a major version, and a bare `<check-id>` mutes a whole check. Full catalog: [docs/FINDING_IDS.md](https://github.com/Back-Road-Creative/rigscore/blob/main/docs/FINDING_IDS.md).

#### Semantic tool-description judge

Static regex checks match known prompt-injection phrasings; a tool description that paraphrases the same intent can slip past them. The opt-in `--semantic` judge adds a model-backed second look:

```bash
npx github:Back-Road-Creative/rigscore --semantic
```

It runs only when you pass `--semantic`. For each tool description (read from the `tools/list` snapshot files listed under `paths.mcpToolsSnapshot` in `.rigscorerc.json`, the same JSON you pipe into `rigscore mcp-hash`), it asks your own agent CLI to classify the text as benign or suspicious: `claude -p` by default, or the command set in `semantic.command` (`gemini`, `codex exec`, and so on). The classification prompt, with the description inside it, is passed to that CLI as its final argument. rigscore uses no API key and no SDK client, but the text is processed by whatever model your CLI uses, so this is not an offline check. Each description is wrapped in a data-only frame and the judge is told to treat it as data. That framing reduces the chance that a crafted description steers the verdict; it does not rule it out, and a model's verdict can be wrong in either direction. If the configured binary isn't on `PATH`, the check skips with no finding. It scores on the advisory (zero-weight) lane; enforcement grade `pattern`.

#### CycloneDX AI-BOM export

`--cyclonedx` prints a CycloneDX 1.6 BOM of the AI components a scan discovers: every repo-level MCP server as a component (with `version` + `purl` when the package is stably pinned), AI client configs and governance files with SHA-256 content digests, and a dependency graph. AI facts (transport, launch command, declared env-var *names*, config-shape hash) ride on `properties` rows.

```bash
npx github:Back-Road-Creative/rigscore --cyclonedx . > ai-bom.json
```

Repo-scoped on purpose — home-dir client configs never land in a shippable BOM. Not combinable with `--recursive`.

#### Docker image

Every `v*.*.*` release tag publishes an image to GHCR. It runs as a non-root user and scans `/workspace` by default:

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/back-road-creative/rigscore:<tag>
```

#### Explain a finding

`rigscore explain <findingId>` prints the docs page for the check behind a finding, jumping to the finding-specific section when one exists:

```bash
npx github:Back-Road-Creative/rigscore explain skill-files/indirect-injection
```

#### Watch mode

`--watch` re-runs rigscore when relevant files change — governance files, MCP configs, `.env`, Docker Compose files, git hooks, `.rigscorerc.json` — debounced at 500ms:

```bash
npx github:Back-Road-Creative/rigscore --watch
```

#### Pre-commit hooks

Two ways to run rigscore before every commit:

- **Built-in** — `rigscore --init-hook` writes a git pre-commit hook that runs a scan with `--fail-under 70`.
- **pre-commit.com framework** — rigscore ships a `.pre-commit-hooks.yaml`, so a repo already using the [pre-commit](https://pre-commit.com) framework adds it as a hook:

```yaml
repos:
  - repo: https://github.com/Back-Road-Creative/rigscore
    rev: v{{< rigscore-fact field="version" >}}
    hooks:
      - id: rigscore
```

#### Sharing one config across repos

A `.rigscorerc.json` can inherit another config with `extends`, so a team maintains one hardened baseline and each repo layers its own overrides on top:

```json
{
  "extends": "../shared/.rigscorerc.json",
  "suppress": ["env-exposure/env-not-gitignored"]
}
```

`extends` takes a local path or an array of them (later entries win); the file that declares `extends` outranks the base it inherits, so a repo always overrides the shared defaults. Bases are resolved recursively and cycles are rejected. Values are read from disk only — an `http(s)://` target is refused, never fetched, so `extends` never adds egress.

#### Plugins

rigscore auto-discovers `rigscore-check-*` packages (scoped `@org/rigscore-check-*` too) from `node_modules` and runs them as extra checks — no core changes needed. Plugins default to weight 0 (advisory); give one scoring weight via `.rigscorerc.json`:

```json
{ "weights": { "my-custom": 5 } }
```

An invalid plugin warns to stderr and is skipped — it never crashes the scan.

#### More flags

| Flag | What it does |
|---|---|
| `--badge` | Generate a markdown score badge for your README |
| `--badge-format <f>` | Badge format: `markdown` (default, shields.io image snippet), `endpoint` (shields.io Endpoint Badge JSON, for a README badge that updates itself), or `svg` (self-contained, no network) |
| `--check <id>` | Run a single check; an N/A check reports `n/a` and exits 0, not a red 0/100 |
| `--code-quality` | Output a GitLab Code Quality report (CodeClimate JSON) |
| `--junit` | Output JUnit XML — one testcase per check, for Jenkins, Azure Pipelines and GitLab |
| `--quiet` / `-q` | Summary-only output: score, grade, posture and finding counts. For pre-commit hooks and terse CI logs |
| `--record-score` | Append this scan's score to `.rigscore-history.json` (opt-in) |
| `--trend` | Print the recorded score history and deltas, then exit — read-only; `--record-score` is what writes it |
| `--cta` / `--no-cta` | Show (`--cta`) or hide (`--no-cta`) the promotional call-to-action footer after a terminal scan — off by default; `--ci` implies `--no-cta` |
| `--include-home-skills` | Also scan the home-scope skill, command, and prompt directories of every registered client — `~/.claude/skills`, `~/.claude/commands`, `~/.codex/prompts`, `~/.gemini/commands`, and the rest — instead of project scope only |
| `--init-hook` | Install a pre-commit hook that runs rigscore with `--fail-under 70` before each commit |
| `--refresh-mcp-registry` | Force refetch of the MCP registry cache (implies `--online`, bypasses the 24h TTL) |

#### Troubleshooting & FAQ

- **Which clients does rigscore scan?** See the [supported-clients matrix](#supported-clients) — every governance file, MCP config, sandbox, and skill directory rigscore reads, listed per client.
- **Why is my score capped below Grade A?** Without a `--deep` scan, a Dockerfile, and infrastructure paths, the reachable weight ceiling is 80, so a repo missing those surfaces tops out at Grade B even with every check passing. That is by design — the absent checks are N/A (weight redistributed via `min(1, W / 100)`), not failing.

For deeper issues — config parse errors, unexpected exit codes, CI setup — see the product [TROUBLESHOOTING guide](https://github.com/Back-Road-Creative/rigscore/blob/main/docs/TROUBLESHOOTING.md).

### Supported clients {#supported-clients}

rigscore reads one client registry and scans, scores and pins whichever of these surfaces exist in your repo. No flag turns a client on; if the file is there, it is scanned.

Each row lists only the surfaces a client has: its **instruction file** (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …); its **MCP config** (a committed *repo* config is what a pull request can mutate, so it's exactly what the CVE-2025-54136 rug-pull pin covers — a `~/` home config is scanned but never pinned); its **sandbox** boundary; and its **skill dirs** (slash-command / skill / prompt directories scanned for hijack and exfil, with home dirs gated behind `--include-home-skills`).

#### The registry

| Client | Instruction file | MCP config | Sandbox | Skill / command dirs |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | `.mcp.json` *(repo)*, `~/.claude.json` | `.claude/settings.json`, `.claude/settings.local.json` | `.claude/commands`, `.claude/skills` *(repo + home)* |
| Claude Desktop | — | `~/.claude/claude_desktop_config.json` | — | — |
| Cursor | `.cursorrules` | `.cursor/mcp.json` *(repo + home)* | `.cursor/permissions.json` | — |
| Windsurf | `.windsurfrules` | `~/.windsurf/mcp.json` | — | — |
| Cline | `.clinerules` | `~/.cline/mcp_settings.json` | — | — |
| Continue | `.continuerules` | `~/.continue/config.json` | — | — |
| GitHub Copilot | `copilot-instructions.md`, `.github/copilot-instructions.md` | `.vscode/mcp.json` *(repo)* | — | — |
| Codex CLI | `AGENTS.md` | in `.codex/config.toml` (TOML) | `.codex/config.toml` *(repo + home)* | `~/.codex/prompts` |
| Aider | `.aider.conf.yml` | — | — | — |
| Gemini CLI | `GEMINI.md` | `.gemini/settings.json` *(repo + home)* | `.gemini/settings.json` | `.gemini/commands` *(repo + home)* |
| opencode | `AGENTS.md` | `opencode.json` *(repo)*, `~/.config/opencode/opencode.json` | `opencode.json` / home config | `.opencode/commands`, `~/.config/opencode/commands` |
| Amp | — | `~/.amp/mcp.json` | — | — |
| Zed | — | `~/.config/zed/settings.json` | — | — |
| Amazon Q Developer | `.amazonq/rules/` (dir) | `.amazonq/mcp.json`, `.amazonq/default.json` *(repo + `~/.aws/amazonq`)* | — | — |
| Roo Code | `.roorules` | `.roo/mcp.json` *(repo)* | — | — |
| Cody | — | `.vscode/settings.json` (`cody.mcpServers`) | — | — |
| JetBrains Junie | `.junie/guidelines.md` | `.junie/mcp/mcp.json` *(repo + home)* | — | — |
| Goose | `.goosehints` | in `~/.config/goose/config.yaml` (YAML) | — | — |
| Warp | — | `.warp/.mcp.json` *(repo + home)* | — | — |
| Kiro | `.kiro/steering/` (dir) | `.kiro/settings/mcp.json` *(repo + home)* | — | — |
| Qwen Code | `QWEN.md` | `.qwen/settings.json` *(repo + home)* | — | — |
| Crush | `CRUSH.md` | `.crush.json` / `crush.json` *(repo)*, `~/.config/crush/crush.json` | — | — |
| OpenClaw | — | `~/.openclaw/openclaw.json` (`mcp.servers`) | — | — |
| Antigravity | `AGENTS.md` | `~/.gemini/antigravity/mcp_config.json` | — | — |

A dash means the client has no such surface, or none at a stable path rigscore can resolve. Codex and Goose keep their MCP servers in TOML and YAML respectively, so the JSON MCP reader doesn't parse them — their servers surface through the sandbox and credential readers instead.

#### Directory-form rule sets

Some clients read a directory of rule files rather than one file. rigscore scans these by default, so a repo governed only by `.cursor/rules/*.mdc`, for example, still counts as governed:

| Directory | Read by | Files |
|---|---|---|
| `.cursor/rules/` | Cursor | `*.mdc` |
| `.windsurf/rules/` | Windsurf | any non-dotfile |
| `.clinerules/` | Cline | any non-dotfile |
| `.github/instructions/` | GitHub Copilot | `*.instructions.md` |
| `.amazonq/rules/` | Amazon Q | `*.md` |
| `.kiro/steering/` | Kiro | `*.md` |

#### Example configs

Starter configurations for the common clients live in the product repo under [`docs/examples/`](https://github.com/Back-Road-Creative/rigscore/tree/main/docs/examples) — ready-to-copy baselines for `claude`, `cursor`, `cline`, `continue`, `copilot`, `windsurf`, `aider`, and a vendor-neutral `agents-md`. For opinionated, check-targeting baselines you can install in place, use the [guard packs](#the-packs-that-ship) (`rigscore init --list-packs`).

### Verify rigscore {#verify-rigscore}

Below is the full verification recipe for the current release, `v{{< rigscore-fact field="version" >}}`. Substitute the tag you are checking.

The canonical reference for these commands lives in the rigscore README — see the **[Verify this tool](https://github.com/Back-Road-Creative/rigscore#verify-this-tool)** section. This section mirrors it for readers who land here first.

#### 1. What a release includes

Each release built by the signed-release workflow (`.github/workflows/release-provenance.yml`) carries:

- A Sigstore-backed **build-provenance attestation** generated by GitHub Actions for the tarball and the SBOM.
- A **CycloneDX SBOM** (software bill of materials) listing dependencies, runtime and transitive.

The repository also publishes a **bypass-test catalog** of cases rigscore does not catch (see [step 6](#6-public-bypass-tests)). The recipe below checks that a downloaded file matches what the release workflow produced; it does not review the source code.

#### 2. Tag signature

```bash
git verify-tag v{{< rigscore-fact field="version" >}}
```

Tag signing is optional for maintainers, so this command can fail on a tag that was not signed. The attestation in step 3 is the main check.

#### 3. Provenance attestation

Two commands:

```bash
gh release download v{{< rigscore-fact field="version" >}} --repo Back-Road-Creative/rigscore --pattern '*.tgz'
gh attestation verify rigscore-{{< rigscore-fact field="version" >}}.tgz --owner Back-Road-Creative
```

One-liner equivalent (downloads, verifies, cleans up):

```bash
scripts/verify-release.sh v{{< rigscore-fact field="version" >}}
```

As written, `gh attestation verify ... --owner Back-Road-Creative` passes when the file's hash has a valid Sigstore attestation issued to a workflow in the `Back-Road-Creative` GitHub organization. The attestation certificate also records the repository, workflow and commit, but this command does not require particular values for them. The release workflow itself runs on any `v*` tag push or manual dispatch. The recipe has not been tested here against a stricter `gh` invocation, so treat the repository, workflow and ref as recorded in the certificate rather than enforced by this command.

What a result tells you:

- **Pass:** the file has an attestation from that organization's GitHub Actions, and its hash matches the attested one.
- **Fail:** the file does not match an attestation, for example because it was altered or built elsewhere.
- **Neither case** shows that the source at the tag is free of malicious changes, or that the maintainers cannot publish an attested release.

#### 4. SBOM review

Every release bundles a CycloneDX SBOM:

```bash
gh release download v{{< rigscore-fact field="version" >}} --repo Back-Road-Creative/rigscore --pattern 'sbom.cdx.json'
cat sbom.cdx.json | jq '.components[].name' | sort -u
```

rigscore has two runtime dependencies:

- `chalk` — terminal coloring
- `yaml` — YAML parsing for governance files

The SBOM lists ~50 components total because it includes the dev/test transitive graph (vitest, esbuild, chai). Everything not listed under `dependencies` in `package.json` is dev-only — present at build time, absent at run time. To see the runtime-only set:

```bash
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies))"
```

The runtime dependency list is intentionally short, which keeps the set of packages to review small.

#### 5. Reproducible bundle hash

Rebuild the tarball locally and compare hashes:

```bash
git clone https://github.com/Back-Road-Creative/rigscore.git
cd rigscore && git checkout v{{< rigscore-fact field="version" >}}
nvm use 20      # match the Node version the release workflow used
npm ci          # package-lock.json is the anchor
npm pack
sha256sum rigscore-{{< rigscore-fact field="version" >}}.tgz
```

Ask the release what the published digest is, rather than trusting a hash typed on this page:

```bash
gh release view v{{< rigscore-fact field="version" >}} --repo Back-Road-Creative/rigscore \
  --json assets --jq '.assets[] | select(.name | endswith(".tgz")) | "\(.digest | sub("^sha256:";""))  \(.name)"'
```

GitHub records the digest on the asset itself, and that `--jq` prints it in exactly `sha256sum` format — so the two outputs compare line for line, and there is no number here to go stale. Or download the asset and hash it yourself:

```bash
gh release download v{{< rigscore-fact field="version" >}} --repo Back-Road-Creative/rigscore --pattern '*.tgz'
sha256sum rigscore-{{< rigscore-fact field="version" >}}.tgz
```

**Caveats.** `npm pack` is reproducible across the same Node minor version when `package-lock.json` is committed (it is); cross-minor or different `npm` versions can shift tar headers. If your local hash differs but the step-3 attestation verifies, the attestation is the stronger signal and the hash recipe is a sanity check. The published digest and the tarball both come from GitHub, so this step shows the build can be reproduced, not that it is independent of GitHub; step 3 is what ties the artifact to a workflow build.

#### 6. Public bypass tests

The rigscore repository publishes tests that record cases rigscore does not catch:

- [`test/keyword-gaming.test.js`](https://github.com/Back-Road-Creative/rigscore/blob/main/test/keyword-gaming.test.js) — checks that match on string presence rather than semantics.
- [`test/mcp-evasion.test.js`](https://github.com/Back-Road-Creative/rigscore/blob/main/test/mcp-evasion.test.js) — MCP server configurations that slip past typosquat / scope checks.
- [`test/injection-evasion.test.js`](https://github.com/Back-Road-Creative/rigscore/blob/main/test/injection-evasion.test.js) — prompt-injection patterns the unicode and skill-file checks do not flag.
- [`test/ansi-injection.test.js`](https://github.com/Back-Road-Creative/rigscore/blob/main/test/ansi-injection.test.js) — ANSI-control-sequence injection in governance files.

They record current behavior: a change that closes one of these gaps turns the matching test into a positive assertion. Treat anything the test suite does not assert as not caught.

#### 7. Threat model

The full attack-surface and out-of-scope catalog lives in the rigscore repo:

- [`THREAT-MODEL.md`](https://github.com/Back-Road-Creative/rigscore/blob/main/THREAT-MODEL.md) — what rigscore inspects, what it doesn't, and the trust boundaries.
- [`docs/known-limits.md`](https://github.com/Back-Road-Creative/rigscore/blob/main/docs/known-limits.md) — concrete examples of attacks rigscore will not detect, with pointers to tools that will.

If you need a check rigscore does not implement, file an issue with a fixture.

### Source and releases

- GitHub: [github.com/Back-Road-Creative/rigscore](https://github.com/Back-Road-Creative/rigscore)
- Releases: [github.com/Back-Road-Creative/rigscore/releases](https://github.com/Back-Road-Creative/rigscore/releases)
- [Command reference](#command-reference) — auto-fix, packs, monorepo, AI-BOM, watch, plugins
- [Supported clients](#supported-clients) — every governance file, MCP config, sandbox, and skill dir rigscore reads, per client
- License: MIT
