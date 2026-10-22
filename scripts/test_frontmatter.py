#!/usr/bin/env python3
"""Validate Hugo front matter structure for all content files.

Catches:
- Files wrapped in code fences (```markdown ... ```)
- Front matter not starting on line 1
- Front matter with no closing delimiter
- Invalid YAML in front matter
- Front matter that does not parse as a YAML mapping
- Missing required fields (title, description — see REQUIRED_FIELDS_ALL)
- Empty title, empty description
- description longer than MAX_DESCRIPTION_LEN, which Google truncates in a
  search snippet (the same <=155 budget site-config/_default/params.toml
  states for the site-level default, previously enforced nowhere)
- Zero-value dates (0001-01-01) indicating Hugo couldn't parse
"""

import os
import sys
import yaml

CONTENT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "content")
REQUIRED_FIELDS_ALL = {"title", "description"}
# SERP truncation budget; params.toml carries the same number for the site default.
MAX_DESCRIPTION_LEN = 155
SKIP_FILES = {"_index.md"}


def extract_frontmatter(filepath):
    """Extract front matter text between --- delimiters. Returns (yaml_str, errors)."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    errors = []
    lines = content.split("\n")

    # Check for code fence wrapping
    if lines and lines[0].strip().startswith("```"):
        errors.append("file starts with a code fence — front matter will not be parsed by Hugo")
        return None, errors

    # Check front matter starts on line 1
    if not lines or lines[0].strip() != "---":
        errors.append("front matter delimiter '---' not found on line 1")
        return None, errors

    # Find closing delimiter
    closing = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            closing = i
            break

    if closing is None:
        errors.append("no closing '---' delimiter found for front matter")
        return None, errors

    yaml_str = "\n".join(lines[1:closing])
    return yaml_str, errors


def validate_file(filepath):
    """Validate a single content file. Returns list of error strings."""
    yaml_str, errors = extract_frontmatter(filepath)

    if yaml_str is None:
        return errors

    # Parse YAML
    try:
        fm = yaml.safe_load(yaml_str)
    except yaml.YAMLError as e:
        errors.append(f"invalid YAML in front matter: {e}")
        return errors

    if not isinstance(fm, dict):
        errors.append("front matter did not parse as a YAML mapping")
        return errors

    # Required fields — every page needs each of REQUIRED_FIELDS_ALL
    for field in sorted(REQUIRED_FIELDS_ALL):
        if field not in fm or fm[field] is None:
            errors.append(f"missing required field: {field}")

    # Zero-value date check
    date_val = fm.get("date")
    if date_val is not None:
        date_str = str(date_val)
        if date_str.startswith("0001-01-01"):
            errors.append("date is zero-value (0001-01-01) — likely unparsed")

    # Empty title
    if fm.get("title") is not None and str(fm["title"]).strip() == "":
        errors.append("title is empty")

    # Empty description
    if fm.get("description") is not None and str(fm["description"]).strip() == "":
        errors.append("description is empty")

    # Over-length description — truncated in a search snippet
    if fm.get("description") is not None:
        desc_len = len(str(fm["description"]))
        if desc_len > MAX_DESCRIPTION_LEN:
            errors.append(
                f"description is {desc_len} chars, over the {MAX_DESCRIPTION_LEN}-char "
                f"limit — trim it by {desc_len - MAX_DESCRIPTION_LEN}"
            )

    return errors


def main():
    if not os.path.isdir(CONTENT_DIR):
        print(f"Content directory not found: {CONTENT_DIR}")
        sys.exit(1)

    total_errors = 0
    files_checked = 0

    for root, _dirs, files in os.walk(CONTENT_DIR):
        for fname in sorted(files):
            if not fname.endswith(".md"):
                continue
            if fname in SKIP_FILES:
                continue

            filepath = os.path.join(root, fname)
            rel = os.path.relpath(filepath, CONTENT_DIR)
            errs = validate_file(filepath)
            files_checked += 1

            if errs:
                for e in errs:
                    print(f"FAIL: content/{rel} — {e}")
                total_errors += len(errs)
            else:
                print(f"  OK: content/{rel}")

    print()
    print(f"Checked {files_checked} files, {total_errors} error(s)")

    if total_errors > 0:
        print("FAILED: Front matter validation failed")
        sys.exit(1)
    else:
        print("PASSED: All front matter valid")
        sys.exit(0)


if __name__ == "__main__":
    main()
