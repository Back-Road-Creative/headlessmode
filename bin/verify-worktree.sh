#!/usr/bin/env bash
# Local mirror of the PR CI's build and test steps, for checking any checkout or
# worktree before pushing.
#
# Nothing is copied from the workflow: at run time this reads
# .github/workflows/pr-ci.yml (or --workflow <path>) and takes from it
#   1. the `npm run build:css` line and the `bash scripts/build-site.sh ...` line,
#   2. every line that starts with `venv/bin/python3 ` and names a scripts/ path,
#      in file order (comment lines are skipped),
#   3. the `run: node --test ...` line, verbatim -- or, once the step goes through
#      the evidence wrapper, the `run: node scripts/qcm/run-with-evidence.mjs ...`
#      line, which runs that same node --test and writes the evidence record.
# It runs them in that order and prints each step's exit code. Every python and
# node step runs even when an earlier one failed; exit 0 only if all passed.
#
# Deliberately NOT mirrored: pa11y, htmltest, the github.com link check
# (scripts/qcm/check-github-links.mjs) and Lighthouse. They need the network or a
# running server, so they stay CI-only.
#
# Usage: bin/verify-worktree.sh [options]
#   --plan               print the ordered command list and exit 0, running nothing
#   --workflow <path>    workflow to read (default .github/workflows/pr-ci.yml)
#   --python <path>      interpreter for the venv/bin/python3 lines
#                        (default ./venv/bin/python3, else the run fails)
#   --node-modules <dir> symlink <dir> as ./node_modules when that is missing
#   --lock <file>        run the node --test step under `flock -w 3600 <file>`
#   --log-dir <dir>      one log per step (default ${TMPDIR:-/tmp}/verify-worktree-<branch>)
#                        (a failed step also prints its last 40 lines in the summary)
#   --skip-build         skip the css and site builds
#   --only node|python   run only that test family (builds still run unless --skip-build)
# Env: VERIFY_PYTEST_PREFIX prefixes every python line (e.g. a test-slot wrapper);
#      CHROME_PATH is passed through, defaulting to the workflow's env: value.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN=0 WORKFLOW=".github/workflows/pr-ci.yml" PYTHON="" NODE_MODULES="" LOCK="" LOG_DIR="" SKIP_BUILD=0 ONLY=""

die() { echo "verify-worktree: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --workflow) WORKFLOW="${2:?--workflow needs a path}"; shift 2 ;;
    --python) PYTHON="${2:?--python needs a path}"; shift 2 ;;
    --node-modules) NODE_MODULES="${2:?--node-modules needs a dir}"; shift 2 ;;
    --lock) LOCK="${2:?--lock needs a file}"; shift 2 ;;
    --log-dir) LOG_DIR="${2:?--log-dir needs a dir}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --only) ONLY="${2:?--only needs node or python}"; shift 2
            case "$ONLY" in node|python) ;; *) die "--only takes node or python" ;; esac ;;
    -h|--help) sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

cd "$ROOT" || die "cannot cd to $ROOT"
[ -f "$WORKFLOW" ] || die "workflow not found: $WORKFLOW"

# One awk pass over the workflow: KIND<TAB>text. Comments never match because the
# stripped line must START with the command.
parsed="$(awk '
  { line=$0; sub(/[ \t\r]+$/, "", line)
    s=line; sub(/^[ \t]*(- )?/, "", s); sub(/^run:[ \t]*/, "", s)
    if (s ~ /^#/) next
    if (s == "npm run build:css") print "CSS\t" s
    else if (s ~ /^bash scripts\/build-site\.sh /) print "SITE\t" s
    else if (s ~ /^venv\/bin\/python3 / && s ~ /scripts\//) { sub(/^venv\/bin\/python3 /, "", s); print "PY\t" s }
    if (line ~ /^[ \t]*run:[ \t]+node (--test|scripts\/qcm\/run-with-evidence\.mjs) /) { n=line; sub(/^[ \t]*run:[ \t]+/, "", n); print "NODE\t" n }
    if (!chrome && line ~ /^[ \t]*CHROME_PATH:/) { c=line; sub(/^[ \t]*CHROME_PATH:[ \t]*/, "", c); sub(/[ \t]+#.*$/, "", c); gsub(/[\047"]/, "", c); print "CHROME\t" c; chrome=1 }
  }' "$WORKFLOW")"

CSS_CMD="" SITE_CMD="" NODE_CMD="" WF_CHROME="" PY_ARGS=()
while IFS=$'\t' read -r kind text; do
  case "$kind" in
    CSS) [ -n "$CSS_CMD" ] || CSS_CMD="$text" ;;
    SITE) [ -n "$SITE_CMD" ] || SITE_CMD="$text" ;;
    NODE) [ -n "$NODE_CMD" ] || NODE_CMD="$text" ;;
    CHROME) WF_CHROME="$text" ;;
    PY) PY_ARGS+=("$text") ;;
  esac
done <<< "$parsed"

[ "$ONLY" = node ] || [ "${#PY_ARGS[@]}" -gt 0 ] || die "no venv/bin/python3 scripts/ lines found in $WORKFLOW"
[ "$ONLY" = python ] || [ -n "$NODE_CMD" ] || die "no 'run: node --test' or 'run: node scripts/qcm/run-with-evidence.mjs' line found in $WORKFLOW"
if [ "$SKIP_BUILD" -eq 0 ]; then
  [ -n "$CSS_CMD" ] || die "no 'npm run build:css' line found in $WORKFLOW (use --skip-build to skip builds)"
  [ -n "$SITE_CMD" ] || die "no 'bash scripts/build-site.sh' line found in $WORKFLOW (use --skip-build to skip builds)"
fi

PY_BIN="${PYTHON:-./venv/bin/python3}"
PY_Q="$(printf '%q' "$PY_BIN")"
NAMES=() CMDS=()
add() { NAMES+=("$1"); CMDS+=("$2"); }

if [ "$SKIP_BUILD" -eq 0 ]; then
  add "build:css" "$CSS_CMD"
  add "build:site" "$SITE_CMD"
fi
if [ "$ONLY" != node ]; then
  for tail in "${PY_ARGS[@]}"; do
    cmd="$PY_Q $tail"
    [ -z "${VERIFY_PYTEST_PREFIX:-}" ] || cmd="$VERIFY_PYTEST_PREFIX $cmd"
    add "python: $tail" "$cmd"
  done
fi
if [ "$ONLY" != python ]; then
  cmd="$NODE_CMD"
  [ -z "$LOCK" ] || cmd="flock -w 3600 $(printf '%q' "$LOCK") $cmd"
  add "node --test" "$cmd"
fi

if [ "$PLAN" -eq 1 ]; then
  printf '%s\n' "${CMDS[@]}"
  exit 0
fi

# Real run from here.
if [ "$ONLY" != node ] && [ "${#PY_ARGS[@]}" -gt 0 ] && [ ! -x "$PY_BIN" ]; then
  die "python interpreter not found or not executable: $PY_BIN (create ./venv, or pass --python <path>)"
fi
if [ ! -e node_modules ] && [ -n "$NODE_MODULES" ]; then
  [ -d "$NODE_MODULES" ] || die "--node-modules is not a directory: $NODE_MODULES"
  ln -s "$NODE_MODULES" node_modules || die "could not symlink node_modules"
fi
if [ -z "$LOG_DIR" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  LOG_DIR="${TMPDIR:-/tmp}/verify-worktree-${branch//\//-}"
fi
mkdir -p "$LOG_DIR" || die "cannot create log dir $LOG_DIR"
export CHROME_PATH="${CHROME_PATH:-$WF_CHROME}"
# The evidence wrapper writes its record under $RUNNER_TEMP, which only a runner sets.
export RUNNER_TEMP="${RUNNER_TEMP:-$LOG_DIR}"
[ -n "$CHROME_PATH" ] || unset CHROME_PATH

RESULTS=() FAILED=0 FAILED_LOGS=()
for i in "${!CMDS[@]}"; do
  log="$(printf '%s/%02d.log' "$LOG_DIR" "$((i + 1))")"
  echo "== [$((i + 1))/${#CMDS[@]}] ${NAMES[$i]}" >&2
  bash -c "${CMDS[$i]}" > "$log" 2>&1
  rc=$?
  status=PASS
  if [ "$rc" -ne 0 ]; then status=FAIL; FAILED=$((FAILED + 1)); FAILED_LOGS+=("$i"); fi
  RESULTS+=("$status  exit $rc  ${NAMES[$i]}  (log: $log)")
  # A failed build makes the python steps that read public/ meaningless; still
  # run them all, as the CI does, and let the summary say which step broke first.
done

echo
echo "verify-worktree summary ($WORKFLOW):"
printf '  %s\n' "${RESULTS[@]}"
if [ "$FAILED" -eq 0 ]; then
  echo "all ${#CMDS[@]} steps passed"
  exit 0
fi
# The log dir is usually a temp dir that is gone by the time anyone reads a CI
# run, so a path alone loses the reason: print the end of each failed log here.
for i in "${FAILED_LOGS[@]}"; do
  log="$(printf '%s/%02d.log' "$LOG_DIR" "$((i + 1))")"
  echo
  echo "-- last 40 lines of FAILED step $((i + 1)): ${NAMES[$i]}"
  tail -n "40" "$log" | sed 's/^/  | /'
done
echo "$FAILED of ${#CMDS[@]} steps FAILED"
exit 1
