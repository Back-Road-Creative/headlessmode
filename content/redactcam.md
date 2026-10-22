---
title: "redactcam — face and license-plate redaction for video"
description: "Blur faces, license plates and vehicle cabins in video, then check the mask against a second detection pass on vehicle cabins before encoding."
date: 2026-08-01
draft: false
layout: redactcam-demo
tags: ["open-source", "privacy", "redaction", "computer-vision", "demo"]
---

redactcam takes a video file, finds faces, license plates and vehicles, and writes a blurred copy. The
stages run in this order: detect, filter, track, mask, verify, encode. Detection is an estimate, so the
output needs a human review before it is shared (see [Limits and review](#limits-and-review)).

## Detection

Four ONNX models do the finding: one each for faces, plates, vehicles and people (vehicles and people
share one COCO model). Detection is expensive, so it runs on a sample of frames. The ROAD_FOOTAGE preset,
which is tuned for forward-facing 4K video from a moving vehicle, samples plates at 8 frames per second and
faces at 16. A 4K frame is cut into overlapping 1280-pixel tiles so a distant plate is not shrunk away
before the network sees it, and a moving plate is re-detected on every frame.

## Filtering false positives

Confidence alone did not separate the objects the preset was tuned against. A place-name sign scored about
0.6 on the plate model, above any threshold that still kept the plates in that footage. The preset filters
on box shape and size instead. The figure above shows the plate filter and the ranges the preset's comments
record; it is an illustration of those numbers, not a result (see its note for the footage and preset).

Faces are filtered over time. Foliage and shadows scored 0.5 to 0.7 on the face model, higher than a small
real face at 0.19. The preset sets the face confidence very low and requires a track to accumulate at least
two detections before it is emitted, because a real face tends to re-detect across samples and a texture
artifact tends to fire once. Lowering the face confidence without that requirement blurs hedges.

These settings come from one kind of footage. For a fixed camera, a handheld phone or a drone, the aspect
and area limits are likely to be wrong, and the project's README suggests starting from the function
defaults and adding filters one at a time.

## Tracking

Between detections, redactcam moves each box on every frame with Lucas-Kanade optical flow, which follows
where a patch of pixels went, plus a RANSAC scale term so the box of an approaching object grows with it.
Each new detection resets the box. Without this, a box held from the last sample covers empty road while the
plate drives out from under it.

Occupants are handled differently. Face detection through a moving windscreen picks up reflections and roof
lines, so the preset detects the whole vehicle and blurs the top 60% of its box, where people sit. That
covers the cabin whether or not a face was found, and it also blurs anything else in that band.

## Output and verification

The tracked boxes become a timeline, then a grayscale mask clip, then a blurred H.264 re-encode through
ffmpeg. The verification step runs before that encode. It re-runs vehicle detection on the source frames,
requires a license plate to corroborate each vehicle, and checks that the mask covers each corroborated
vehicle's cabin. A cabin the mask leaves uncovered raises `CoverageError` and nothing is rendered. The check
is on the mask, not the finished video, because a render can carry other changes that would confound a
comparison with the source.

The check is narrow. Only the vehicle cabin has an independent verifier. The report lists faces, plates
and people as `UNCHECKED`, which means unknown, not safe, and a run with zero vehicle sightings reports the
cabin as `UNCHECKED` too. A face that the detector misses twice is missed by both passes, so a passing
coverage report does not show that every sensitive region was detected.

## Limits and review

- Output is pseudonymized, not anonymous. Gait, clothing, vehicle, location and timestamp survive a face
  blur.
- Recall depends on the models. The preset compensates for known failure modes of the default weights, and
  other weights have other failure modes.
- The cabin check passes at a coverage of 0.5 by default, not 1.0. That tolerates a box a few percent
  off, and it can be raised.
- The blur is irreversible and applied to a re-encode (CRF 18 by default), so everything in the frame
  loses a generation. Keep the original.
- Before sharing the output, watch it. Look for plates and faces at the edges of the frame, small or distant
  subjects, and anything the models were not trained to find.

## Command line

To skip the Windows installer above and install straight from the source, choose one onnxruntime extra
(`cpu` runs anywhere, `gpu` uses CUDA):

```
pip install "redactcam[cpu] @ git+https://github.com/Back-Road-Creative/redactcam"
pip install "redactcam[gpu] @ git+https://github.com/Back-Road-Creative/redactcam"
```

The README also lists `redactcam[centerface]`, a weaker fallback face detector, and `redactcam[dev]`, which
adds the test tools and the CPU runtime.

```
redactcam dashcam.mp4 -o dashcam_redacted.mp4 -v
```

`--no-render` stops after the mask and the coverage check, for when you would rather bring your own
encode. Exit code `2` means the coverage check failed, or a class named with `--require-verified` was not
verified, and nothing was rendered. Only `cabin` can be verified today, so requiring another class always
refuses.

## Requirements

Python 3.11 or newer, and an `ffmpeg`/`ffprobe` binary on the path. The mask render and the blur composite
both shell out to it.

The Windows installer above is redactcam frozen into one executable, so it needs no Python, and it is a
large download because opencv and onnxruntime are frozen in with it. It does not bundle ffmpeg, which
redactcam needs to render anything: `winget install -e --id Gyan.FFmpeg` puts both binaries on `PATH`, and
`choco install ffmpeg` works too. It does not bundle model weights either, so the first run needs a network
connection to fetch roughly 110 MB of ONNX files once over HTTPS, checksum-verified and cached. A machine
that will never reach the internet needs the files supplied instead, through `--model`.

## Where it fits

redactcam is one of the four open tools [Waypost](/waypost/), the studio's creator console, fronts for video
and photo capture-to-publish. It blurs faces and plates before the encode, and it runs without the console.

## Documentation

{{< system-docs name="redactcam" >}}

## Licensing

Two licenses apply, and they are separate. The redactcam software is MIT. The model weights it downloads by
default are third-party files with their own terms: the face model is GPL-3.0, the plate model is AGPL-3.0,
and the vehicle and person model declares no license. Offering redaction as a network service on the AGPL
plate model carries obligations. Read the README's license section before deploying anything.
