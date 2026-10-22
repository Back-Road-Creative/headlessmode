---
title: "pycube-lut — apply a 3D LUT to a NumPy image"
description: "Load an Adobe .cube 3D LUT, a HALD CLUT PNG or a 1D tone curve and apply it to a NumPy image in one call. Pure NumPy: no ffmpeg, OpenColorIO or GPU."
date: 2026-08-06
draft: false
tags: ["open-source", "color", "lut", "numpy", "video"]
---

pycube-lut loads a LUT file and applies it to an image that is already in memory as a NumPy array. It
reads Adobe `.cube` 3D LUTs, HALD CLUT PNGs and 1D `.cube` tone curves, and it interpolates trilinearly.
Install it with `pip install git+https://github.com/Back-Road-Creative/pycube-lut` (Python 3.11 or later).

```python
import numpy as np
from pycube_lut import apply_cube, load_cube

cube = load_cube("look.cube")        # or "look.png" (HALD CLUT), or a 1D curve .cube
graded = apply_cube(image, cube)     # image: HxWx3 uint8 or uint16, same dtype back
half = apply_cube(image, cube, 0.5)  # strength 0.5: halfway back toward the original
```

---

## Supported inputs

| You have | `load_cube` gives you |
|---|---|
| Adobe `.cube` with `LUT_3D_SIZE` | the table as-is; `DOMAIN_MIN` and `DOMAIN_MAX` are honored |
| HALD CLUT PNG (a square grid image) | the same kind of table, read from the pixels |
| `.cube` with `LUT_1D_SIZE` (three tone curves) | a separable 3D cube, resampled to 33 points per axis |

- **Data order.** In a 3D `.cube` the red value changes fastest, then green, then blue. That is the order
  the Adobe Cube specification defines, and getting it wrong swaps channels.
- **HALD CLUT.** The file is recognized by its `.png` suffix. The image must be square with a pixel count
  that is a perfect cube, and reading it needs Pillow, which the `hald` extra installs:
  `pip install "pycube-lut[hald] @ git+https://github.com/Back-Road-Creative/pycube-lut"`. A `.cube` or 1D
  curve needs NumPy only.
- **1D curves.** The equivalent 3D table grows with the cube of the curve length, so a 1024-entry curve
  would need about 10⁹ entries. Each curve is resampled to 33 points instead, so the loaded cube is an
  approximation of the original curve.
- **Malformed files.** Every load or apply failure raises `CubeError`, a `ValueError` subclass, naming the
  path. A wrong number of data rows, a bad size line, bad HALD geometry, or a NaN, infinite or
  float32-overflowing value is rejected rather than loaded as a truncated table.

---

## Interpolation, arrays and strength

`apply_cube` interpolates trilinearly between the eight nearest table entries. It is the only method
available; there is no tetrahedral option.

- **Array types.** The image must be `HxWx3` with dtype `uint8` or `uint16`. Float, signed integer, `uint32`
  and bool arrays raise `CubeError`; convert them first. The output has the same dtype and shape as the
  input. An RGBA array has the wrong shape and raises the same error.
- **Strength.** `strength` runs from 0 to 1 and values outside that range are clamped. The result is
  `lut_output * strength + input * (1 - strength)` in normalized float, then rounded to the integer type.
  At 1.0 the result is the full LUT, and at 0.0 it is the input.
- **Memory.** The whole image is processed at once and the function allocates several float32 arrays of
  the image's size. Split very large images into tiles yourself.
- **Read-only.** The library has no LUT writer and no LUT inversion.

---

## Color-management limits

pycube-lut applies the table to whatever values the array holds. It does no color management: it does not
read an image's color profile, convert between color spaces, or check that the input matches what the LUT
was built for. A LUT authored for log footage expects log-encoded input, and applying it to sRGB pixels
gives a wrong result without any warning.

Returning the input dtype keeps 16-bit data in 16 bits. It says nothing about whether the colors are
correct for your pipeline. That depends on the input encoding matching the LUT, and the LUT's own
output encoding being what you expect.

---

## Worked example

The LUT here is a small `.cube` generated for this page, not a product. It has `LUT_3D_SIZE 17`. For each
entry, take Rec. 709 luma (`0.2126·R + 0.7152·G + 0.0722·B` on normalized values), add
`0.15·(luma − 0.5)` to red, subtract `0.15·(luma − 0.5)` from blue, clamp to 0–1, and pass green through.
Write the 4,913 rows with red varying fastest and the numbers below reproduce. The input is four literal
RGB swatches, not a photograph. This is the output of a run against the repository's main branch at commit `54cc640`. The dtype check described above is listed under Unreleased in the changelog, so install from the repository:

```
cube: 17 (17, 17, 17, 3) | dtype in/out: uint8 uint8
shadow    [24 28 34] -> [ 9 28 49]   @0.5 [17 28 41]
midtone   [110 110 110] -> [107 110 113]   @0.5 [109 110 111]
skin      [196 150 120] -> [201 150 115]   @0.5 [198 150 118]
highlight [235 232 228] -> [250 232 212]   @0.5 [243 232 220]
```

Shadows shift toward blue and highlights toward orange, the midtone moves by three levels, and green is
unchanged because this LUT only alters red and blue. In the `@0.5` column each value lands halfway
between the input and the full-strength result.

For a smaller check that needs no LUT file, this script writes a 5-point table that sends red to green,
green to blue and blue to red, then applies it:

```python
import numpy as np
from pycube_lut import apply_cube, load_cube

size = 5
axis = np.linspace(0.0, 1.0, size)
rows = [f"{b:.4f} {r:.4f} {g:.4f}" for b in axis for g in axis for r in axis]
open("swap.cube", "w").write("\n".join([f"LUT_3D_SIZE {size}", *rows]) + "\n")

cube = load_cube("swap.cube")
red = np.zeros((2, 2, 3), np.uint8)
red[..., 0] = 200
print(apply_cube(red, cube)[0, 0])       # [  0 200   0]
print(apply_cube(red, cube, 0.5)[0, 0])  # [100 100   0]
```

---

## Optional LUT selection

For a library of LUTs, `select_luts` ranks them against a small thumbnail of your image and a
`SceneHints` description (warmth, dynamic range, chroma headroom). It measures what each LUT does to the
thumbnail, since a `.cube` carries no metadata about its look. Its scoring weights were tuned on landscape
and travel photographs and are module constants you can change. See the README in the repository for
usage.

---

## Where it fits

[Waypost](/waypost/), the studio's creator console, uses pycube-lut for grading. The library runs
without it.

## Documentation

{{< system-docs name="pycube-lut" >}}
