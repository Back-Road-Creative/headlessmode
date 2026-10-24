---
title: "Waypost — the creator console"
description: "A self-hosted console for video runs, photo develop, SEO and comments, with a publishing queue for YouTube, Instagram, Facebook and manual TikTok posts."
date: 2026-08-31
draft: false
tags: ["creator-tools", "video-pipeline", "self-hosted", "automation"]
---

> **Access.** Waypost is pre-release. The source is public under MIT at
> [Back-Road-Creative/waypost](https://github.com/Back-Road-Creative/waypost), and there is no
> installer or versioned release. It is available through a studio engagement;
> [contact me](/contact/) for setup.

**[Open the read-only demo →](/demo/waypost/)** — a fixed fictional console for a made-up brand,
frozen at 2026-09-01. The forms and buttons are removed, so it shows a saved example and
cannot submit anything.

Waypost is a web console that runs on your own machine. It starts video and photo runs in
the GoMoveShift pipeline, shows their progress and holds the publishing queue.
[Go Move Shift](https://gomoveshift.com/), a travel video channel, is made with it.
Each brand gets its own tab, with its own queue and credentials.

## Media workflow

- **Video.** The Drives tab launches the same pipeline command you would run by hand. A run
  can stop at a review gate; the operator answers it in the console, from a phone browser if
  needed, and the run continues.
- **Photos.** Ingest and develop run from the console. Selection, reels and astro runs are
  started from the command line.
- **SEO and comments.** A corrections ledger for place names used in titles and descriptions,
  and a comments tab for follow-up.
- **Tools underneath.** The pipeline runs on [Framegrade](/framegrade/), the media engine for
  grading, photo sharpening and trail films. It calls [keycut](/keycut/) for
  keyframe-aligned cuts, [redactcam](/redactcam/) for blurring, [pycube-lut](/pycube-lut/) for
  grading and [sun-track](/sun-track/) for sun position.

## Publishing routes

Approved shorts are planned into a queue, one calendar per brand. The queue allows one active
delivery per short per platform and does not republish one that is already published. Each
platform works differently:

- **YouTube.** Uploaded as private with a publish time, and YouTube makes it public at that
  time. It needs a YouTube OAuth token, stored SOPS-encrypted. A spent daily quota delays the
  upload and retries it later.
- **Facebook.** Reels are uploaded with a scheduled publish time between 10 minutes and 29
  days ahead. It needs the Meta Page credentials.
- **Instagram.** Reels publish when the queue sends them; Instagram is not given a future
  time. It uses the same Meta credentials, and its data access lapses after 90 days unless
  the Meta setup script is run again.
- **TikTok.** The studio's TikTok app is unaudited, so Direct Post is unavailable. The default
  route writes the video and its caption to a folder, and the owner schedules the post in
  TikTok Studio. The row stays "Needs manual publishing" until the owner marks it published in
  the console. Inbox and direct modes exist behind a setting but are not the default.

First comments linking the full video are posted on YouTube, Instagram and Facebook, not
TikTok. A failed delivery or a missed slot can post to a notification URL the operator sets.

## Running it

Waypost runs as a container with its state on a separate volume. Backup and restore scripts
are included, with a restore drill that opens the newest archive; scheduling the nightly
backup is a setup step. Console login by token is optional.

## Documentation

{{< system-docs name="Waypost" >}}
