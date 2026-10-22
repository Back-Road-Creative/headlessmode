# Service Lifecycle Declaration

**Service:** site-headlessmode
**State:** ACTIVE
**Owner:** @joepetjr
**Last Reviewed:** 2026-07-14
**Auto-Review Date:** 2026-10-14 (90 days from last review)

## State Definitions

- **ACTIVE:** Under active development, receives regular updates, full CI coverage
- **MAINTENANCE:** Stable, minimal changes, security patches only, reduced CI
- **ARCHIVED:** No further development, frozen for reference, excluded from CI

## Ownership Responsibilities

- Review lifecycle declaration quarterly
- Respond to security vulnerability notifications within 7 days
- Approve/reject dependency updates within 14 days
- Document planned deprecation 30 days in advance

## Migration Policy

State transitions require:
- ACTIVE → MAINTENANCE: Document stabilization criteria, reduce CI to smoke tests
- MAINTENANCE → ARCHIVED: Notify dependents 30 days in advance, document alternatives
- Any state → ACTIVE: Assign owner, enable full CI, update dependencies

---

## Current Declaration

**State:** ACTIVE
**Owner:** @joepetjr
**Declared By:** Site hygiene sweep
**Declaration Date:** 2026-07-14

## Service Description

HeadlessMode public site: the studio site for Back Road Creative — a home page
carrying the full software roster, pages for the products and tools with
something to show, and rigscore's manual. Hugo static site (custom
`headlessmode` theme, `site-config/` config dir) deployed to Cloudflare Pages via
GitHub Actions. Content tree: the homepage (the roster at `/#software`, rendered
from `data/systems.json`), product and tool pages (`rigscore.md`, `driftless.md`,
`quiet-corners.md`, `redactcam.md`, `sun-track.md`), and `about.md`. The
`/systems/`, `/docs/` and `/releases/` sections were retired; `static/_redirects`
301s them.

## Commit Activity

- **Status:** Actively maintained with regular updates
- **Last reviewed:** 2026-07-14

## Dependencies

- Hugo extended (static site generator)
- Node.js (Tailwind CSS build, rigscore data and validation scripts)
- Python 3.x (frontmatter and content validators in `scripts/`)
