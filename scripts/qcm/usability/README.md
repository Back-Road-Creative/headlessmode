# Usability lane

A model is given a plain task ("find out whether this map shows traffic cameras, turn them on,
...") and the screen, and answers one action at a time. A separate verifier then reads the page
and decides whether the task was really done. The lane is **advisory**: it reports, it never
repairs a build, accepts a screenshot baseline, or blocks a merge.

There is one task per acceptance journey, `J01` to `J10` (`../acceptance-manifest.json`), so the
lane runs all ten. `J10` (Recovery) has a task and a recorded run like the rest.

| File | Job |
| --- | --- |
| `tasks.json` | The ten tasks: goal in plain words, step and time budget, and the `checks` the verifier reads from the page. The model never sees the checks, and task text carries no selector or click order. |
| `adapter.mjs` | The model adapter. `recorded` replays saved answers. `live` is refused until a provider is chosen and authorised. |
| `runner.mjs` | Runs one task. Every action is checked against a small vocabulary (click, type, key, scroll, wait, done, giveUp) before it reaches the page. Ends at done, give up, the step budget, the time budget, a refused action, or an adapter or driver error. |
| `verifier.mjs` | Compares the page's facts with the checks. A "done" claim with failing facts is a `claim-mismatch` failure; passing facts with no claim is a failure flagged `unclaimed-pass`. A fact the page did not report fails. |
| `calibration.mjs` | Scores the lane itself: a known-good build called a failure is a false positive, a seeded failure called a pass is a false negative. |
| `recordings.json` | Recorded answers and the facts a driver would read, for every journey on a known-good build, plus seeded failures (covered Clear, stale selection after reload, missing camera group, clipped card, wrong active count, keyboard trap). |
| `lane.mjs` | Runs everything and prints the report. |

## Run it

```sh
node scripts/qcm/usability/lane.mjs            # one line per journey, then the calibration
node scripts/qcm/usability/lane.mjs --json     # the full report
node scripts/qcm/usability/lane.mjs --strict   # exit 1 on a false positive or false negative
```

It makes no network call and starts no browser. `usability-lane.test.mjs` (in `scripts/qcm/`, so
PR CI's glob runs it) covers the runner's budgets, the verifier, the calibration rules and the
CLI.

## Becoming a gate

A task becomes merge-blocking only after **ten consecutive scheduled rounds** in which every
seeded failure was caught and no known-good build was called a failure. One miss restarts the
count (`calibrationStatus`). Until then every result is advice for a reviewer, and subjective
findings stay reviewable either way. The deterministic gates elsewhere in this suite stay in place.

## What is not here yet

- A live driver that points a browser at the built site and reads the page facts. Today the facts
  come from the recordings. The first four journeys to calibrate on a live driver are `J01`,
  `J03`, `J05` and `J07` (`phase: first` in `tasks.json`).
- A live model. A provider has to be chosen first: a local model must show it can read a
  screenshot, and any external provider needs explicit authorisation before the `live` adapter is
  written. Nothing in this folder calls one.
- Scheduled rounds. The count of consecutive clean rounds needs a place to be kept between runs.
