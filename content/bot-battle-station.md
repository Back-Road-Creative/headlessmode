---
title: "bot-battle-station — a live wall screen for your Claude Code sessions"
description: "A wall screen for every Claude Code session on your machine: which need you, which are working, which wait on a job, with ETAs and a DEFCON ladder."
date: 2026-10-20
draft: false
tags: ["open-source", "ai-agents", "monitoring", "cli"]
---

## What it does

bot-battle-station is a live wall screen for every Claude Code session on your machine: which one
needs you, which are working, which are waiting on a test run or CI, and when each should be done.
It is a web page served on 127.0.0.1, and it also has a full-screen terminal view. It spends no
tokens and reads only the files Claude Code already writes.

<img src="/img/bot-battle-station/board.png" alt="The bot-battle-station board with six demo sessions: DEFCON 1, Claude and Codex usage limits, a waiting-on-you banner, and tiles for needs-you, waiting-on-job, running and idle sessions" width="1600" height="720" loading="lazy">

Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names; this
is an independent tool that reads the local files Claude Code writes.

---

## What it shows

One tile per live session, NEEDS YOU first, then in the order they should finish. A tile shows the
session's topic, a ring with percent done and minutes left, what it asks or is doing now, its next
plan steps and its running jobs.

| State | When |
|---|---|
| NEEDS YOU | Claude Code says the session is waiting (a permission prompt, a question, a plan to approve), or a line of its last reply matches one of your `ask_commands` |
| RUNNING | Claude Code says the session is busy |
| WAITING ON JOB | a background command, watcher or helper agent is still running |
| IDLE | anything else |

The header carries a DEFCON ladder from 1 to 5. DEFCON 1 means a session needs you: the page goes
to a full-screen red takeover, plays a siren once you arm it, and sends a desktop notification.
DEFCON 2 (amber) means something is wrong, such as a job behind its usual run or a context 90% full.
DEFCON 3, 4 and 5 are calm: sessions waiting on jobs, sessions working, and all quiet.

ETAs are medians of what already finished on your machine. With fewer than 4 finished runs a job is
never called behind.

---

## Privacy

- **No tokens, no network, no subprocess.** It reads Claude Code's session files and transcripts, and
  only the bytes appended since the last poll.
- **Served on 127.0.0.1 only**, and only to a request whose `Host` is `localhost`, `127.0.0.1` or
  `[::1]`.
- **Transcript text is untrusted.** The page writes every value with `textContent` and makes no
  outside requests.
- **`--doctor`** prints counts and key names, never a path, name, id or text, so its output can go in
  a bug report.

---

## Quick start

```
git clone https://github.com/Back-Road-Creative/bot-battle-station.git
cd bot-battle-station
python3 bin/session-board.py --demo
```

`--demo` shows five invented sessions in a temporary directory, so you can look at the board before
pointing it at your own. Run `python3 bin/session-board.py` without `--demo` to see your sessions at
`http://localhost:8765`, or add `--tui` for the terminal board.

---

## Requirements

Python 3.11 or newer, standard library only. Linux and WSL are what it is built and tested on. On
macOS it works without the `/proc` checks. Windows-native Claude Code is not covered. It reads Claude
Code's internal files, which have no published format and can change; if a number looks wrong after
an update, run `--doctor` and open an issue with its output. MIT licensed.

---

## Documentation

{{< system-docs name="bot-battle-station" >}}
