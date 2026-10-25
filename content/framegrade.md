---
title: "Framegrade — the media engine"
description: "A media engine that grades video and photos, checks each finished file and builds route films from GPS tracks. Available as tagged source; used by the studio media workflow."
date: 2026-10-08
draft: false
tags: ["creator-tools", "video-pipeline", "photo-develop", "automation"]
---

> **Access.** The source is public under Apache-2.0 at
> [Back-Road-Creative/framegrade](https://github.com/Back-Road-Creative/framegrade).
> A versioned source package is available; open **Release details** above for the current
> tag and verified source commit. Follow the repository's installation instructions.
> Help with deployment is available through a studio engagement;
> [contact me](/contact/) for setup.

Framegrade is the engine that turns raw video and photos into finished files. It does the
picture work only: it does not title, schedule or publish anything. [Waypost](/waypost/) runs it
underneath and adds the console, the review gate and the publishing queue.

## What it does

- **Grading.** A look is applied to a whole day of footage, and to photos, through the same grade
  engine. The look is a LUT built from a sampled analysis of the footage, applied with
  [pycube-lut](/pycube-lut/).
- **Sharpening and noise reduction from measurement.** The amount of each follows a measurement
  of the picture and is zero when the picture does not need it. Photo develop works this way
  today. Bringing the same measured policy to video is in progress; until it lands, video
  sharpening is off.
- **Declared upscaling.** A source smaller than the delivery size can be scaled up instead of
  being refused. The run records that it was upscaled, and a setting can stop a title from
  claiming a native resolution the source did not have. This is in progress.
- **Trail films.** A route film opens on satellite imagery that zooms from a wide view down to
  the start of the track, then follows the GPS track with photos placed by capture time and a
  placed video clip.
- **Inserts.** A still or a clip placed at a chosen point in a long video, fitted to the frame and
  cut on keyframes with [keycut](/keycut/). This is in progress.
- **Picture gates.** A finished file is checked against its delivery size, color tags, loudness,
  freeze and black frames, and blur coverage. A failure stops the run. Faces and plates are blurred with [redactcam](/redactcam/).

## How it is used

Framegrade takes a run description (sources, a GPS track, a brand profile and the text to burn
in) and returns the finished files with their sidecar measurements and gate results. The brand
profile carries the look, the logo, the delivery presets and the upscale policy, so the engine
holds no brand name of its own.

## Documentation

{{< system-docs name="Framegrade" >}}
