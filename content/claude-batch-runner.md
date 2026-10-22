---
title: "claude-batch-runner — run agent calls as a batch job"
description: "Run a batch of Claude Code agent calls from a JSON spec: validates the spec, runs units in parallel, and writes a report of outcomes and token use."
date: 2026-08-06
draft: false
tags: ["open-source", "ai-agents", "automation", "cli"]
---

## What it does

claude-batch-runner runs one `claude -p` process per unit of work, in parallel, from a campaign
spec: a JSON file naming a worklist, the agent that processes each unit, and the shape of the
result. The loop that decides what runs is ordinary code, so every unit in the worklist is
dispatched and every unit appears in the report. The model is called only to do the work, to redo a
unit on escalation, and to grade it.

---

## Configuring a campaign

The spec requires three fields: `worklist`, `worker` and `schema`.

- **`worklist`** is a file with one unit per line, either a JSON value or a bare string such as a
  path. It is resolved relative to the spec file.
- **`worker`** is `{agent, tier, effort}`: the agent that processes each unit. The agent must
  already exist in your Claude Code setup.
- **`schema`** is the JSON schema every worker result must match.
- **`parallelism`** is optional and sets how many workers run at once. The default is the smaller
  of the unit count and 4.
- **`escalate`** is optional: `{condition, advisor}`. Units whose output matches the condition are
  redone by the advisor agent.
- **`verify`** is optional: `{rubric, agent, tier, effort, max_revisions}`. It grades each unit
  against a rubric file.
- **`deliver`** is `report-only` (the default) or `pr-dispatch`. `pr-dispatch` is a stub that
  raises `NotImplementedError`, so use `report-only`.
- **`report`** is an optional output path template. `{date}` and `{campaign}` are substituted, and
  the default is `reports/{date}-{campaign}.md`.

---

## Validation

The spec is checked before any agent runs. An unknown field, a missing required field, an invalid
tier name, a missing worklist or rubric file, or an empty worklist stops the run with an error that
names the field, and no tokens are spent.

The escalation condition is parsed before the batch starts, too. It has the form
`<field> <op> <number>`, for example `confidence < 0.6`, and it is checked against a numeric field
of the worker's structured output. There is no boolean logic; to select a subset of units,
filter the worklist.

With `verify` set, a grader scores each unit against a rubric: a markdown file with one
`## N. <id>` section per criterion. On any failing criterion, the worker is re-invoked with the
failed criteria attached, up to `max_revisions` times (default 1). A unit that still fails is marked
`FLAGGED`. A grader result with no evidence, or that is otherwise malformed, is rejected and never
counted as a pass. The grader may not run on the cheapest tier.

---

## Concurrency

Each unit is a separate `claude` subprocess, and `parallelism` sets how many run at once. The limit
is threads around subprocesses, so what your machine and your rate limits allow is the practical
ceiling. Each call is bounded by `AGENT_TIMEOUT_S` (default 600 seconds). On Linux and macOS a
timeout stops the whole process tree; on Windows only the direct child is stopped.

---

## Result files

A real run writes one markdown report, at the `report` path. It has a header line (date, wall-clock
time, worker, parallelism), a count of outcomes (`ok`, `escalated`, `revised`, `FLAGGED`), a table
with one row per unit, a cost table of calls and tokens per tier, and a short handoff block. Each
unit row shows the unit number, the input, the outcome, the verify result, the number of revisions,
the tokens used and a note.

Call counts are exact. Token counts come from the `usage` field on each result when the CLI
provides one, and the report states how many results carried none.

---

## Failed units

A worker that errors out, an advisor or verify call that errors, and a unit that still fails its
rubric after the allowed revisions all come back as `FLAGGED` rows. The note column gives the
error or the failed criterion ids, and the rest of the batch keeps running. After a run, read the
`FLAGGED` rows in the report and fix the cause, such as an agent that does not exist or a
rubric the output cannot meet.

The runner has no resume: a campaign that stops partway starts over from the first unit. Split a
large worklist into several campaigns, or remove finished units from the worklist before re-running.

---

## Quick start

```
python -m claude_batch_runner --spec campaign.json --dry-run
```

`--dry-run` validates the spec and counts units without dispatching anything or spending a token.
It prints the worker, parallelism, escalation, schema, verify and report settings it would use.
Drop `--dry-run` to run the campaign, which calls the agents named in the spec and costs tokens.

---

## Requirements

Python 3.11+, standard library only beyond the `claude` CLI it shells out to, one process per
unit of work. That CLI must already be on `PATH` and authenticated. The runner uses whatever
authentication the CLI already has and never reads or sets credentials of its own.

The Windows installer above, `claude-batch-runner-setup-<version>.exe` (attached to each release),
is the runner frozen into one executable, so it needs no Python. Claude Code is separate and is not
bundled: with no `claude` on `PATH` every unit comes back `FLAGGED` and the campaign accomplishes
nothing. The installer puts the runner in Program Files and appends that directory to the system
`PATH`; open a new terminal afterwards, because one already open still holds the old `PATH`.

---

## Documentation

{{< system-docs name="claude-batch-runner" >}}
