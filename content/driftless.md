---
title: "Driftless — project management with computed status"
description: "Manages portfolios, programs and projects with computed status, guided assistants for each technique and a method map, all from data entered once"
date: 2026-08-28
draft: false
tags: ["project-management", "pmbok", "autonomous-agents", "mechanical-enforcement"]
---

Driftless keeps one record of a portfolio's projects and calculates their status, schedules,
earned value and reports from it.

**[Open the read-only demo →](/demo/driftless/)** — a fixed fictional portfolio as of
2026-07-01. Every page is a real Driftless screen with the write controls removed.

{{< driftless-page-count >}} pages: the portfolio dashboard, one project's hub with its
schedule, board, RAID log and assistants, and the method reference. RAID is risks,
assumptions, issues and decisions. Each part of the method reference opens on its own:

{{< driftless-method-sections >}}

## What you enter and what it produces

Driftless keeps one record of the work: business, portfolio, program, project,
workstream and task. For each project it also holds baselines, milestones, sprints,
risks, issues, change requests, budget lines and dated costs, and for departments and
people it holds capacity and cost rate. Microsoft Project XML and Primavera P6 XER
schedules can be imported.

From those records it produces the dashboard, schedules, earned value (what the work
done so far is worth against plan), forecasts and rollups. It also writes Markdown
reports such as a charter, a risk register, a schedule and a weekly status. Each report takes an as-of
date you give it, so generating it again for the same date, records and Driftless version
gives the same file.

Percent complete is not typed. It is calculated from the recorded task data, so it
reflects what was entered and nothing more; it does not tell you whether the recorded
progress matches the real work.

## Baselines and review

A change to the plan goes through a change request, and approving it creates a new
baseline version. An approved baseline is not edited afterward. Governance decisions
are recorded in a sign-off ledger that only the admin role can write to.

## Techniques and the method map

The technique library lists 90 PMBOK techniques. In Driftless, 55 have an assistant
you can run, such as an earned-value calculator or a risk-response planner. The demo shows
each one as a saved page. The other 35 have a
printable worksheet. The
method map links processes, techniques and artifacts, and for a chosen project shows
the state of each process.

## People and agents

The JSON API, the command line, the web wizard and an MCP server (a tool interface for
AI agents) write through the same validation, role checks and change log. An agent's
writes are recorded under its own token, and a viewer role can read every page but
cannot write.

## Availability

Contact for setup. The source is public under Apache-2.0 at
[Back-Road-Creative/driftless](https://github.com/Back-Road-Creative/driftless), and
there is no installer or self-service release. Its administration guide describes
running an instance on a host with Docker Compose, PostgreSQL, a DNS name and
encrypted secrets, then creating users and API tokens. To discuss setup,
[get in touch](/contact/).

---

## Documentation

{{< system-docs name="Driftless" >}}
