# Standing Indian print proof

The one physical check that settles the builder's paper claims. While
`print-proof.json`'s `status` is not `passed`, `qcm-controls.html` renders a
"not yet verified on paper" caveat wherever the builder is hosted, and
`scripts/qcm/print-proof.test.mjs` fails if any host carries the builder without
it. Once the record is `passed` with numbers inside tolerance the caveat stops
rendering on its own — nothing to remember, because the conditional reads the
record. Flipping the record is the whole change.

Layout is not what this proves. Sheet geometry — the frame, header and footer
bands, and seam registration between adjacent sheets — is settled in CI with no
paper by `scripts/qcm/sheet-plan.test.mjs` and `scripts/qcm/browser.test.mjs`
(plan §4, U-Q1 to U-Q3). Steps 7 and 8 below confirm the *printer* honours a
seam that is already proven correct in the PDF, so a failure there is a print
setting, not a layout bug.

## Procedure

1. Open `/quiet-corners/?fixture=standing-indian` in desktop Chromium or
   Edge (the two browsers this product targets).
2. Build the PDF for the Standing Indian / Wayah Bald fixture rectangle.
3. Print every sheet at **Actual size / 100%**, Fit and Shrink off.
4. Also print one sheet with Fit **on**, to confirm it visibly breaks the
   printed scale (a legibility check, not a tolerance).
5. Measure the 4-inch scale-bar segment on a printed sheet with a ruler;
   record the percent error from 4.000 in.
6. Measure each sheet's outer dimensions against the expected Letter
   trim size; record the largest error in millimeters.
7. Tape four adjacent seams. At four points along each seam, measure the
   offset in millimeters between the same map feature on the two sheets.
   Record every reading — at least four seams' worth.
8. Confirm no tiles are missing at any seam.
9. Confirm the printed grayscale halftone keeps every legend class visually
   distinct, the legend matches the printed symbols exactly, and the sheet
   index diagram matches the sheet IDs actually printed.
10. Fill every field of `print-proof.json`: dates, printer, browser, print
    dialog, page/byte/timing counts, every measurement above, and the photo
    filenames backing them.

## Setting `status`

Set `status` to `passed` only if **all** hold: scale-bar error ≤ 0.5%,
sheet-dimension error ≤ 1 mm, every recorded seam offset ≤ 1 mm across at
least four seams, zero missing tiles, and the three quality booleans true.

`failed` is a valid outcome, not an error state: if any tolerance misses,
set `status` to `failed`, record the numbers and a `notes` line explaining
what missed, and leave the four surfaces unlinked. Re-run the procedure
after a fix; do not force `passed` to make the test go green.
