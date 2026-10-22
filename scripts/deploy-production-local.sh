#!/bin/bash
# Production deploy — thin dispatch wrapper.
#
# This script used to build Hugo locally and FORCE-PUSH the production branch,
# bypassing every validation gate in .github/workflows/deploy-production.yml
# (content, links, accessibility, security headers, Lighthouse, deploy-marker
# confirmation). That path is retired: the workflow runs on a self-hosted
# runner, so the original "save CI minutes" rationale no longer applies, and
# no local build may reach production unvalidated.
#
# All this does now is dispatch the real workflow on master and follow it.

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: gh CLI is required (https://cli.github.com)." >&2
    exit 1
fi

WORKFLOW="deploy-production.yml"

echo "Dispatching ${WORKFLOW} on master..."
gh workflow run "$WORKFLOW" --ref master

echo "Waiting for the run to register..."
sleep 5
RUN_ID=$(gh run list --workflow "$WORKFLOW" --branch master --limit 1 --json databaseId --jq '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    echo "Dispatched, but could not resolve the run id. Watch it with: gh run list --workflow $WORKFLOW" >&2
    exit 0
fi

echo "Following run $RUN_ID (Ctrl-C detaches; the run keeps going)..."
gh run watch "$RUN_ID" --exit-status
