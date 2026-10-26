#!/usr/bin/env python3
"""Resolve a stable source tag, without pretending it is a GitHub Release.

Only the workflow uses gh; --tags-json accepts captured paginated responses for
an offline run. A tag-list commit SHA is the peeled commit for annotated tags.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


STABLE_TAG = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def resolve(repo, pages, requested=""):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("source repository must be owner/repo")
    tags = [tag for page in pages for tag in page]
    candidates = [tag for tag in tags if STABLE_TAG.fullmatch(tag.get("name", ""))]
    if requested:
        candidates = [tag for tag in candidates if tag["name"] == requested]
    if not candidates:
        raise ValueError("no matching stable source tag; refusing to invent a version")
    selected = max(candidates, key=lambda tag: tuple(
        int(part) for part in STABLE_TAG.fullmatch(tag["name"]).groups()
    ))
    sha = selected.get("commit", {}).get("sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("source tag has no verified commit SHA")
    return {
        "release_source": "github-tag",
        "tag_name": selected["name"],
        "source_commit": sha,
        "published_at": None,
        "html_url": f"https://github.com/{repo}/tree/{selected['name']}",
        "assets": [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("--tag", default="")
    parser.add_argument("--tags-json", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        parser.error("source repository must be owner/repo")
    try:
        if args.tags_json:
            pages = json.loads(args.tags_json.read_text())
        else:
            response = subprocess.run(
                ["gh", "api", f"repos/{args.repo}/tags?per_page=100", "--paginate", "--slurp"],
                check=True, capture_output=True, text=True, timeout=60,
            )
            pages = json.loads(response.stdout)
        payload = resolve(args.repo, pages, args.tag)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        print(f"error: cannot resolve source tag: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
