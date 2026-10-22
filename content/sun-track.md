---
title: "sun-track — solar elevation and golden hour from a GPX track"
description: "sun-track estimates the sun's elevation for a place and UTC time, flags the golden-hour band, and matches photo timestamps to GPX track positions."
date: 2026-08-01
draft: false
layout: sun-track-demo
tags: ["open-source", "solar", "gpx", "photography", "demo"]
---

sun-track is a Python library and command-line tool with two parts. The first estimates how high
the sun is above the horizon at a latitude, longitude and UTC time, and reports whether that
elevation falls in a band it calls golden hour. The second looks up where a GPX track log put you at
a given time, so a photo with a timestamp but no GPS coordinates can still get a position. Install
it with `pip install git+https://github.com/Back-Road-Creative/sun-track`. It needs Python 3.11 or
newer, has no runtime dependencies and makes no network calls.

## Estimating the sun's position

`solar_elevation_deg()` returns the sun's apparent elevation in degrees: positive above the horizon,
negative below. It uses the NOAA solar-position algorithm (equation of time, declination, hour angle)
plus a standard atmospheric-refraction correction, so the result is where the sun appears to be
rather than the purely geometric angle. It returns elevation only. There is no azimuth, no
sunrise, sunset or twilight times, and no moon.

## How it classifies golden hour

The tool has one photographic period: golden hour, defined as an apparent elevation from −4° to +6°,
both edges included. `is_golden_elevation()` tests a number against that band and `is_golden_at()`
does both steps from a position and a time. The edges are a photographic judgment, not a physical
constant: −4° reaches into the afterglow just after sunset, and +6° is roughly where the light stops
reading as warm. They are defined in one place in the source (`GOLDEN_ELEVATION_MIN` and
`GOLDEN_ELEVATION_MAX`), and nothing else in the library depends on those values.

Elevation is a useful stand-in because a low sun shines through more atmosphere. It is only one input
to how light looks. Clouds, haze, smoke and nearby terrain change the result, and a time inside the
band is a calculated window, not a promise of warm light.

It is also why a fixed clock window does not work. At 55° north on the Greenwich meridian the
morning band runs 07:49–09:22 UTC in mid-January and 02:46–04:20 UTC at the June solstice. A fixed
07:00–08:00 rule overlaps the January band by about eleven minutes and misses the June one. Moving
15° east shifts the June band to 01:46–03:20, exactly an hour earlier (four minutes per degree of
longitude). On the equator at the June solstice the band is about 43 minutes long, because the sun
crosses those elevations more steeply.

## About the examples above

The figure and table are calculated examples, not measurements of real light. The curve is
`solar_elevation_deg()` evaluated every five minutes across one UTC day. The golden windows come from
testing `is_golden_elevation()` once a minute. The values are sun-track 0.1.0's output, saved as
[a JSON file](/data/sun-track/elevation.json) so the page can stay static. The four places and dates
were picked to change one variable at a time, and each value can be reproduced:

```
$ python -m sun_track sun 55.0 0.0 2026-01-15T08:00:00Z
-2.624 golden
```

## Accuracy

The declination and equation-of-time terms are Fourier fits in day-of-year, not a full ephemeris.
The project documents the worst-case error as about half a degree of apparent elevation. The error
is a few hundredths of a degree near the solstices and a few tenths near the equinoxes, because the
sun's declination changes fastest then. The fits depend only on the calendar date, so a given date
gives the same answer in every non-leap year while the real sun drifts about a quarter of a day per
year within the leap cycle.

The repository's tests are the evidence for that figure, and they cover a limited range. They check
the day's peak elevation at longitude 0 in 2026: within 0.1° at the solstices (latitudes 0°, ±35°,
53° and 66.5°) and within 0.6° at the equinoxes (10°, 53° and −40°), where part of that slack
comes from the reference value rather than the code. Other checks cover the equation of time, the
four-minutes-per-degree longitude shift, and polar day and night. Treat half a degree as the
author's estimate within that range. It is good enough for a ten-degree band and not for pointing a
telescope; for arc-seconds, use an ephemeris library.

Other limits:

- Precision falls off within a degree or so of straight overhead, which only matters in the
  tropics near local noon.
- Refraction assumes a standard atmosphere. Within a degree or so of the horizon, real refraction
  varies by a few tenths of a degree with temperature and pressure.
- There is no terrain and no observer altitude. A ridge to the west puts the sun out of sight
  before the computed elevation reaches zero.

## Input and time zones

Every entry point needs a timezone-aware datetime; any aware value is converted to UTC. A naive
datetime raises `ValueError` instead of being guessed. Reading a camera's local clock time as UTC
is the largest error source here: an hour of error is roughly 10 to 18 degrees of elevation at
mid-latitudes, as large as or larger than the whole ten-degree golden band. The command line is
more lenient: it takes ISO-8601 times, and one with no offset is read as UTC, as the GPX format
specifies for its own timestamps. Convert a camera's local time yourself before passing it in.

## Matching timestamps to track positions

`load_track_index()` reads every `*.gpx` file directly inside a directory (not subdirectories) and
merges them into one time-sorted index. Only `<trkpt>` points with a `<time>` and valid `lat` and
`lon` are indexed; waypoints, routes and untimed points are ignored. A file that cannot be parsed
is skipped with a warning, and a malformed point is dropped on its own.

`TrackIndex.position_at()` linearly interpolates between the two points on either side of the
time you give it. The interpolation is a straight line in latitude and longitude, not a path along a
road or a great circle, with longitude taken the short way across the date line. The result is a
plausible position, not a fix, and `fix_at()` returns the same position with an `inferred` flag that
is false only when the logger recorded a point at exactly that instant.

How wide a gap is accepted depends on the policy:

- **Default:** the position is returned when the nearer of the two bracketing points is within
  `max_gap_min` minutes, 90 by default. A capture just after a point that precedes a three-hour
  hole is still placed, by interpolating across the whole hole. Before the first point or after
  the last, it returns that end point's own position if it is within the window. It never
  extrapolates.
- **`strict=True`:** `max_gap_min` limits the span between the two bracketing points, so a capture
  inside a wider hole is refused wherever it falls, and a capture before the first or after the last
  point is refused. Use it when a position will be shown as evidence of where the camera was.

Both return `None` when nothing qualifies. There is no filtering on reported GPS accuracy or speed.
From the shell, `python -m sun_track where <dir> <time> [max-gap-minutes]` prints `lat,lon` or `NONE`
(exit 1); it uses the default policy only.

## Using the two together

The parts compose but neither imports the other: take a position from the track, then ask for the
elevation there. A kilometre of position error moves the elevation by about a hundredth of a
degree, according to the library's own notes, so a coarse track position is usually enough.

```python
position = index.position_at(capture_utc)
golden = position is not None and is_golden_at(position[0], position[1], capture_utc)
```

## Where it fits

[Waypost](/waypost/), the studio's creator console, lists sun-track among the four open tools it
fronts. It runs without the console. sun-track is MIT licensed.

## Documentation

{{< system-docs name="sun-track" >}}
