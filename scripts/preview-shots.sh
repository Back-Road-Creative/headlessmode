#!/usr/bin/env bash
# Screenshot harness — shoot key pages of a running preview and audit every shot.
# No preview round ships sight-unseen: run this, look at every PNG, then share the URL.
#
# Usage: bash scripts/preview-shots.sh <port> [outdir]
#   outdir defaults to ./preview-shots-<port> (gitignored scratch — do not commit shots).
#
# The matrix covers the top-level product pages AND the /demo/driftless/ pages that
# carry the riskiest displays — maps, flows, gantts, heatmaps, charts. Those shipped a
# thumbnail-sized method map and an empty Flow page to production while every
# structural gate stayed green, because nothing ever looked at them.
#
# Beside each image the run records an audit row (page, viewport, image dimensions,
# HTTP status, verdict) in <outdir>/audit.tsv and FAILS on a 404/non-200, a capture
# error, a blank (single-colour) image, or a document that scrolls sideways (its
# scrollWidth exceeds the viewport — read over the DevTools protocol by
# scripts/preview-overflow.mjs, because a screenshot pinned to --window-size cannot
# show it). A human looking at pictures is not the only gate.
#
# Uses the system chromium (no Playwright dependency), or $CHROME_PATH when set.
# Snap-packaged chromium cannot write outside $HOME, so each shot is staged in $HOME
# and moved to outdir. PREVIEW_SHOTS_DEVTOOLS_WAIT_S (default 60) bounds how long the
# overflow probe's chromium may take to start; one that exits early fails at once.
set -euo pipefail

PORT="${1:?usage: preview-shots.sh <port> [outdir]}"
OUT="${2:-preview-shots-$PORT}"
BIN="${CHROME_PATH:-$(command -v chromium-browser || command -v chromium || true)}"
[ -n "$BIN" ] || { echo "no chromium/chromium-browser on PATH" >&2; exit 1; }

# Overridable so the test suite can point the harness at a throwaway server.
# /quiet-corners/ and its Field Maps sub-surface were absent from this list, which
# is why a document-level overflow on the dashboard sat unnoticed: the probe only
# ever measured pages someone remembered to name here.
PAGES="${PREVIEW_SHOTS_PAGES:-/ /rigscore/ /keycut/ /driftless/ /about/ \
/quiet-corners/ /quiet-corners/maps/ /band-coach/ /waypost/ \
/demo/driftless/ /demo/driftless/map.html /demo/driftless/process-map.html \
/demo/driftless/projects-1-flow.html /demo/driftless/projects-1-gantt.html \
/demo/driftless/org-heatmap.html /demo/driftless/projects-1-assist-cost.html \
/demo/driftless/methods.html /demo/driftless/pmbok-proof.html \
/demo/waypost/ /demo/waypost/pubqueue.html \
/grant-platform/ /demo/grant-platform/ /demo/grant-platform/awards.html \
/demo/grant-platform/reports-core.work_schedule.html \
/demo/grant-platform/reports-path.opportunity_matches.html}"
WIDTHS="${PREVIEW_SHOTS_WIDTHS:-1440 390}"
PROBE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preview-overflow.mjs"

# Reads a PNG and prints "<width>x<height> <ok|blank>". A screenshot of a broken page
# is byte-for-byte nearly the size of a good one, so blankness is decided from the
# pixels: an image is blank when every scanline's filter deltas are zero, which is
# true exactly when every pixel holds the same colour.
INSPECT_PNG='
import struct, sys, zlib
d = open(sys.argv[1], "rb").read()
w, h = struct.unpack(">II", d[16:24])
depth, colour = d[24], d[25]
idat, i = b"", 8
while i < len(d):
    ln = int.from_bytes(d[i:i + 4], "big")
    if d[i + 4:i + 8] == b"IDAT":
        idat += d[i + 8:i + 8 + ln]
    i += 12 + ln
bpp = max(1, {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour] * depth // 8)
raw = zlib.decompress(idat)
stride = 1 + (w * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour] * depth + 7) // 8
blank, tone = True, None
for r in range(h):
    row = raw[r * stride:(r + 1) * stride]
    filt, data = row[0], row[1:]
    head, tail = data[:bpp], data[bpp:]
    # Deltas against a zero row on the top edge leave the first pixel raw, so the
    # tone is read there and every later row must predict away to nothing.
    if filt == 0 or (filt == 2 and r == 0):
        blank = data == head * (len(data) // bpp)
    elif filt == 1 or r == 0:
        blank = tail == bytes(len(tail))
    else:
        blank = data == bytes(len(data))
    if blank and filt in (0, 1):
        blank = tone in (None, head)
    if not blank:
        break
    if r == 0:
        tone = head
print("%dx%d %s" % (w, h, "blank" if blank else "ok"))
'

mkdir -p "$OUT"
AUDIT="$OUT/audit.tsv"
printf 'page\tviewport\timage\tdimensions\tstatus\tscrollwidth\tverdict\n' > "$AUDIT"
failures=0

# One long-lived chromium for the overflow probe. Snap chromium can only write
# under $HOME, so its profile is staged there too; port 0 makes chromium pick a
# free port and write it to DevToolsActivePort.
PROFILE="$HOME/.preview-shot-$$-profile"
"$BIN" --headless=new --no-sandbox --disable-gpu --remote-debugging-port=0 \
    --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 &
PROBE_PID=$!
cleanup() {
    kill "$PROBE_PID" 2>/dev/null || true
    wait "$PROBE_PID" 2>/dev/null || true
    rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT
# A busy CI runner can take well over 10 s to start chromium (PR CI run
# 37756427043 failed at a 10 s wait), so wait up to
# PREVIEW_SHOTS_DEVTOOLS_WAIT_S (default 60) while the process is alive, and
# stop at once if it exits without writing its port.
DEVTOOLS_WAIT_S="${PREVIEW_SHOTS_DEVTOOLS_WAIT_S:-60}"
for _ in $(seq 1 $((DEVTOOLS_WAIT_S * 5))); do
    [ -s "$PROFILE/DevToolsActivePort" ] && break
    kill -0 "$PROBE_PID" 2>/dev/null || {
        echo "preview-shots: chromium exited before exposing a DevTools port" >&2; exit 1; }
    sleep 0.2
done
DEVTOOLS_PORT="$(head -n1 "$PROFILE/DevToolsActivePort" 2>/dev/null || true)"
[ -n "$DEVTOOLS_PORT" ] || {
    echo "preview-shots: chromium exposed no DevTools port within ${DEVTOOLS_WAIT_S}s" >&2; exit 1; }

for page in $PAGES; do
    slug="$(printf '%s' "$page" | sed 's/\.html$//' | tr -s '/' '-' | sed 's/^-//;s/-$//')"
    [ -n "$slug" ] || slug=home
    # curl already writes 000 when it cannot connect; a fallback echo would append a second.
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$page" || true)"
    status="${status:-000}"
    for w in $WIDTHS; do
        shot="$OUT/$slug-$w.png"
        stage="$HOME/.preview-shot-$$-$slug-$w.png"
        dims="-"
        verdict="ok"
        if ! "$BIN" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
            --virtual-time-budget=8000 --window-size="$w,3200" \
            --screenshot="$stage" "http://localhost:$PORT$page" >/dev/null 2>&1; then
            verdict="capture-error"
        fi
        if [ -f "$stage" ]; then
            mv "$stage" "$shot"
            if read -r dims state < <(python3 -c "$INSPECT_PNG" "$shot" 2>/dev/null); then
                [ "$state" = ok ] || verdict="blank-image"
            else
                verdict="unreadable-png"
            fi
        elif [ "$verdict" = ok ]; then
            verdict="no-image"
        fi
        scrollw="-"
        if [ "$status" = 200 ] && [ "$verdict" = ok ]; then
            if scrollw="$(node "$PROBE" "$DEVTOOLS_PORT" "http://localhost:$PORT$page" "$w" 2>/dev/null)"; then
                [ "$scrollw" -le "$w" ] || verdict="overflow-$scrollw"
            else
                scrollw="-"; verdict="probe-error"
            fi
        fi
        [ "$status" = 200 ] || verdict="http-$status"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$page" "${w}x3200" "$shot" "$dims" "$status" "$scrollw" "$verdict" >> "$AUDIT"
        echo "$shot  ${w}x3200  $dims  $status  $scrollw  $verdict"
        [ "$verdict" = ok ] || failures=$((failures + 1))
    done
done

echo "audit: $AUDIT"
if [ "$failures" -gt 0 ]; then
    echo "preview-shots: $failures shot(s) failed the audit — see $AUDIT" >&2
    exit 1
fi
