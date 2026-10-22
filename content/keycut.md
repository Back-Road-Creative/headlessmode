---
title: "keycut — multi-range video cutting on keyframes"
description: "Cut several ranges from a video and join them into one file. Copy cuts start on keyframes; a range is re-encoded only when a copy cannot be used."
date: 2026-08-06
draft: false
tags: ["open-source", "video", "ffmpeg", "keyframes", "cli"]
---

keycut cuts several ranges out of one video and joins them into a single file. By default it copies the video stream instead of re-encoding it, so each copied range has to start on a keyframe. keycut finds the keyframes first and moves each start forward onto one. It runs from the command line or as a Python function, and it calls `ffmpeg` and `ffprobe`.

---

## Copy cuts and re-encoding

keycut uses two ways to produce a range.

**Copy (the default).** The video packets are moved without being decoded, so the range is not re-encoded. A copy can only begin on a keyframe, so keycut moves a requested start forward to the next keyframe. The head of a range can lose up to one group of pictures (GOP: the span from one keyframe to just before the next). Audio is copied as well.

**Re-encode (only when a copy cannot be used).** A range is re-encoded in two cases: the master's keyframes could not be read, or the range is next to footage you excluded with `-x/--exclude` and a copy would pull some of it back in. That range is decoded, cut at the exact requested time and encoded again, so the video in it is not a bit-for-bit copy. The encoder arguments come from the master's codec, pixel format and color metadata, so the piece can be joined to the copied ones. Audio is still copied. Every other range in the same job stays a copy.

Pass `--no-reencode` to never re-encode. A range whose start cannot be aligned is then copied from the keyframe before it, and up to one GOP of earlier footage comes along.

### Why a plain `-c copy` cut is not enough

With `ffmpeg -ss … -c copy`, a start that falls between keyframes begins at the keyframe at or before it. In keycut's integration tests (ffmpeg git build 2026-04-10, mp4 output), ffmpeg wrote those extra frames to the file and added an edit list that tells players to skip them, so the clip looked the right length in a player. The concat demuxer reads packets and ignores edit lists, so joining two such clips played the skipped frames again. Two consequences:

- Two adjacent ranges joined this way replay the end of the first at the start of the second.
- A span you meant to remove, such as the gap between two ranges, can partly return.

Other ffmpeg versions and output formats were not tested. keycut avoids the problem by only starting a copy on a keyframe, and it merges ranges so no join is left to replay anything.

### What keycut does before it cuts

1. It asks `ffprobe` for every keyframe timestamp in the first video stream.
2. It merges ranges that overlap or sit closer together than one GOP. A gap that narrow has no keyframe in it, so a copy cannot remove it; keycut keeps the gap instead. With an exclude window, ranges are never merged across a gap that contains an excluded second.
3. It moves each remaining start forward to the first keyframe at or after it. Range ends are not aligned.
4. It copies or re-encodes each range, then joins the pieces with the concat demuxer, also as a copy.

The merge threshold is the master's effective GOP: the 95th-percentile gap between consecutive keyframes, plus a 5% margin. If the keyframes cannot be read it falls back to 2.1 seconds. `--max-gap SECONDS` overrides it.

---

## Command line

```
keycut master.mp4 highlights.mp4 -r 0:30 1:15 -r 4:00 4:45
```

Each `-r START END` is a range to keep, written as `SS`, `MM:SS` or `HH:MM:SS`. Ranges can be repeated and are joined in the order given. `-x START END` marks footage that must not appear in the output. On success keycut prints the output path; on failure it exits with status 1 and logs the ffmpeg error.

### Dry run

`--dry-run` (`-n`) prints the plan and stops. It reads the master with `ffprobe`, which scans every video packet and takes time on a long file. It does not run `ffmpeg`, create the output file or create the scratch directory. The plan shows how many keyframes were found, the merge gap, which ranges merged, how far each start moved, and whether each range would be copied or re-encoded. It does not check that the later `ffmpeg` runs will succeed.

---

## The plan on a test file

The master is a synthetic 30-second `ffmpeg` `testsrc` clip, 640×360 at 30 fps, with a keyframe every 2 seconds. No customer footage is involved. This is keycut's dry-run output for it, run again against the current source:

```
$ keycut source.mp4 highlights.mp4 -r 0:05 0:11 -r 0:12 0:17 -r 0:21 0:27 --dry-run
master:    source.mp4
keyframes: 15
merge gap: 2.100s
requested: 3 range(s) -> 2 extraction(s)
  [0] 6.000 -> 17.000  stream copy (start aligned +1.000s)
  [1] 22.000 -> 27.000  stream copy (start aligned +1.000s)
```

Three ranges became two cuts. The first two are 1 second apart, which is less than the merge gap of 2.100 s (the 2.0 s keyframe spacing plus the 5% margin), so they were merged. Each surviving start moved forward onto the next keyframe: 5 s to 6 s and 21 s to 22 s, the `+1.000s` on each row. Without the dry-run flag, the same command wrote a 16-second file: 11 seconds from the first cut and 5 from the second.

---

## Limits

- Up to one GOP is lost from the head of each copied range. A range shorter than one GOP may have no keyframe to move to; its start then stays where it was, and the copy begins at the keyframe before it.
- Audio is cut at packet boundaries, so expect up to about a frame of audio drift (around 21 ms for AAC) at each join.
- The concat demuxer rewrites timestamps. Chapters, subtitle tracks and other timeline data are not carried over; keycut cuts video and audio.
- The keyframe scan reads the whole file. The project estimates about a second per hour of footage on a local disk. Results are cached for the life of the process.
- Sources with open GOPs are not handled specially. The first frames after a cut may show artifacts.
- In the Python API a failed extraction returns `None` instead of raising an error, so check the return value.

---

## Requirements

Python 3.11 or later, with `ffmpeg` and `ffprobe` on `PATH`. keycut has no Python dependencies. The Windows installer from the [releases page](https://github.com/Back-Road-Creative/keycut/releases/latest) does not include ffmpeg; `winget install -e --id Gyan.FFmpeg` or `choco install ffmpeg` puts it on `PATH`. The installer is not code-signed, so Windows may show a SmartScreen warning.

---

## Where it fits

[Waypost](/waypost/), the studio's creator console, lists keycut among the open tools it works with. keycut runs on its own and does not need the console.

## Documentation

{{< system-docs name="keycut" >}}
