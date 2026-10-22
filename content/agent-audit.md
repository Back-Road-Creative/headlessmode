---
title: "agent-audit — audit the config you hand an AI coding agent"
description: "Command-line audit of AI coding-agent configuration: skill and instruction files, workflow maturity. Fixed checks in Python, optional model review."
date: 2026-08-06
draft: false
tags: ["open-source", "ai-agents", "audit", "cli", "governance"]
---

agent-audit is a command-line tool that audits the configuration you give an AI coding agent: skill
and agent definitions, standing instruction files, and the overall shape of a setup. It writes a
Markdown report you can keep and compare with the next run.

## How the checks are split

Some questions have exact answers, and agent-audit answers those in Python, the same way on every
run: whether a referenced script exists, how long a file is, whether a `name` field matches its
directory. Other questions need judgment, such as whether a skill file invites unsafe shell use or
two instruction files contradict each other. Those go to a model, one scoped question per pass.

Each model pass runs as a separate `claude` CLI subprocess restricted to the read-only tools Read,
Grep and Glob, and must return JSON that matches a schema. A pass that fails, times out or returns
the wrong shape is listed under **Coverage gaps** in the report instead of counting as no findings.
Model findings are not reproducible between runs and are not verified, so read them as leads. The
structural checks are the part you can diff.

---

## Three commands

- `agent-audit skills .` runs structural, security, quality, determinism and cross-skill passes
  over every `SKILL.md` and agent definition.
- `agent-audit instructions .` looks for contradictions, scores effectiveness, and suggests context
  reductions for `CLAUDE.md`/`AGENTS.md`-style files.
- `agent-audit maturity .` classifies each component as STAY, GRADUATE_CODE or GRADUATE_AGENT.

`skills manifest` and `skills diff` never call a model, so they are cheap enough to run in CI as a
drift check between two checkouts. `skills . --focus structural` also skips the model.

---

## Reports, exit status and budget

By default a report is written to `./agent-audit-reports/<target-slug>/<date>-<kind>.md`. A second
run on the same day writes `-2` instead of overwriting the first, so this week's findings diff
against last week's.

The command exits 0 even when some passes fail, because it still writes a partial report. Check
the Coverage gaps section before treating a report as clean.

`--budget-usd` sets the ceiling for each model pass, not for the whole run, and the passes run
concurrently. It guards against a runaway loop; it is not a spending target or a cap on your bill.
A pass that reaches it returns nothing and appears under Coverage gaps, so a low value produces an
emptier report without saving much.

---

## Requirements and external processing

Python 3.11+, standard library only. The model-backed passes shell out to the `claude` CLI, which
must already be installed and authenticated. agent-audit does not read an API key or open a network
connection itself, but the content it hands to `claude` (your skill files, instruction files and
the prompts built from them) is processed by that CLI and whatever service it is configured to use.

`skills manifest`, `skills diff` and `--focus structural` work without the CLI.

The Windows installer, `agent-audit-setup-<version>.exe` on each release, is agent-audit frozen
into one executable, so it needs no Python. It does not include the `claude` CLI. It installs into
Program Files and appends that directory to the system `PATH`; open a new terminal afterwards,
because one already open keeps the old `PATH`.

---

## Documentation

{{< system-docs name="agent-audit" >}}
