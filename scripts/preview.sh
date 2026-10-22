#!/usr/bin/env bash
# Serve this checkout for a human to look at, and print the URL to open.
#
#   bash scripts/preview.sh [PATH] [PORT]
#   bash scripts/preview.sh --stop [PORT]
#
# PATH is the page to point at (default /), PORT defaults to 1315 (the port
# the deploy and PR workflows also use, so nothing else claims it). Binds to
# 0.0.0.0 so a Windows browser reaches a WSL2 checkout at http://localhost:PORT.
# Runs detached: the URL prints, the shell returns, the server keeps serving
# until `bash scripts/preview.sh --stop`. Cloudflare branch previews serve
# nothing (only the production branch is deployed), so this is the only way to
# see an unmerged branch.
#
# A URL is printed ONLY when all five of these hold, so the helper can never
# hand over someone else's server (it did, on port 1315, 2026-08-30) or a page
# whose linked stylesheet 404s (it did on /band-coach/, 2026-09-25):
#   1. the port was free before launch — an occupied port is refused, not used;
#   2. the Hugo child this script started is recorded and still alive;
#   3. Hugo's own log reports a successful bind on this exact port;
#   4. the served / carries this checkout's Hugo build markers, AND the
#      requested PATH answers 200 rather than 404;
#   5. /css/tailwind.css, which the head partial links, answers 200 — Hugo
#      never compiles it itself, so this script does before launching hugo.
# State (pid + log) is per-port, so two previews cannot confuse each other.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--stop" ]; then
  stopped=0
  if [ -n "${2:-}" ]; then targets=".hugo-preview.${2}.pid"; else targets=$(echo .hugo-preview.*.pid); fi
  # .hugo-preview.pid is the pre-per-port name; stop it too so nothing is orphaned.
  for pidfile in $targets .hugo-preview.pid; do
    [ -f "$pidfile" ] || continue
    if kill "$(cat "$pidfile")" 2>/dev/null; then stopped=1; fi
    rm -f "$pidfile"
  done
  if [ "$stopped" = 1 ]; then echo "preview stopped"; fi
  exit 0
fi

PAGE="${1:-/}"
PORT="${2:-1315}"
if [ "$PORT" -lt 1024 ]; then
  echo "port $PORT needs root; use 1024 or higher" >&2
  exit 64
fi
PIDFILE=".hugo-preview.$PORT.pid"
LOGFILE=".hugo-preview.$PORT.log"
SITE_TITLE=$(sed -n "s/^title *= *['\"]\(.*\)['\"].*/\1/p" site-config/_default/hugo.toml | head -1)

port_is_taken() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; }

# Prove the thing answering on $PORT is the Hugo child we launched, serving THIS
# checkout, and that $PAGE exists there. Every failure is loud.
verify_serving() {
  local pid="$1" body
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "hugo (pid $pid) is not running; see $LOGFILE" >&2
    return 1
  fi
  if ! grep -qF "Web Server is available at http://localhost:$PORT/" "$LOGFILE" 2>/dev/null; then
    return 2 # not bound yet — caller may keep waiting
  fi
  body=$(curl -fs --max-time 5 "http://localhost:$PORT/" 2>/dev/null) || return 2
  case "$body" in
    *'<meta name="generator" content="Hugo'*"$SITE_TITLE"*) ;;
    *)
      echo "port $PORT answered, but not with a Hugo build of $SITE_TITLE from this checkout" >&2
      return 1
      ;;
  esac
  if ! curl -fs -o /dev/null --max-time 5 "http://localhost:$PORT$PAGE"; then
    echo "this checkout is serving on port $PORT, but $PAGE is not a page here" >&2
    return 1
  fi
  if ! curl -fs -o /dev/null --max-time 5 "http://localhost:$PORT/css/tailwind.css"; then
    echo "this checkout is serving on port $PORT, but /css/tailwind.css 404s — the head partial links it and a preview whose stylesheet 404s is not ready" >&2
    return 1
  fi
  return 0
}

# Compile Tailwind before launching hugo — mirrors build_tailwind() in
# scripts/build.sh. Never runs `npm install`; a missing node_modules is a
# loud failure with the one-line remedy, not a silent install.
build_tailwind() {
  if [ ! -f package.json ]; then
    return 0
  fi
  if ! command -v npm &> /dev/null; then
    echo "npm not installed; cannot compile Tailwind CSS for the preview" >&2
    exit 1
  fi
  if [ ! -d node_modules ]; then
    echo "node_modules missing; run: npm ci" >&2
    exit 1
  fi
  if ! npm run build:css --silent; then
    echo "npm run build:css failed; see output above" >&2
    exit 1
  fi
}

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  if verify_serving "$(cat "$PIDFILE")"; then
    echo "already serving (pid $(cat "$PIDFILE")): http://localhost:$PORT$PAGE"
    exit 0
  fi
  echo "the recorded preview on port $PORT no longer checks out; run --stop $PORT and retry" >&2
  exit 1
fi
rm -f "$PIDFILE"

if port_is_taken; then
  echo "port $PORT is already held by another process — refusing to call it a preview of this checkout" >&2
  echo "free it, or pick another: bash scripts/preview.sh $PAGE <PORT>" >&2
  exit 69
fi

build_tailwind

nohup hugo server --bind 0.0.0.0 --port "$PORT" --configDir site-config \
  --disableLiveReload --renderToMemory > "$LOGFILE" 2>&1 &
HUGO_PID=$!
echo "$HUGO_PID" > "$PIDFILE"
# How long a still-alive Hugo may take to report its bind. The loop leaves the
# moment Hugo binds or dies, so a generous ceiling costs nothing on an idle box;
# a fixed 30 here killed a Hugo seconds from binding on 2026-09-28 (PR #617 CI,
# load average 44-64 with three CI runners and two browser suites sharing the
# box). 120 s is the CI job's own order of magnitude for a cold site build under
# that load. PREVIEW_BIND_WAIT overrides it; test_preview_readiness.py holds both.
BIND_WAIT="${PREVIEW_BIND_WAIT:-120}"
for _ in $(seq 1 "$BIND_WAIT"); do
  set +e
  verify_serving "$HUGO_PID"
  status=$?
  set -e
  if [ "$status" = 0 ]; then
    echo "http://localhost:$PORT$PAGE"
    exit 0
  fi
  if [ "$status" = 1 ]; then break; fi
  sleep 1
done
if [ "${status:-1}" = 2 ]; then
  echo "hugo never reported a bind on port $PORT; see $LOGFILE" >&2
fi
kill "$HUGO_PID" 2>/dev/null || true
rm -f "$PIDFILE"
exit 1
