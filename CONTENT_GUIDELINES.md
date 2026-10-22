# HeadlessMode Content Guidelines

## Purpose

Headless Mode is a one-person software studio. Its pages tell a visitor what a product does, who can use it, how to get it, and any limit that changes that decision. Every claim should be checkable against a release, the code or the data; where something is pending or unknown, the page says so.

## Voice and Structure

1. **Lead with a concrete task.** Product name, then what it does, then how to try or get it. Use "I" for the studio's own About and Contact statements and the product name for product behavior. Do not invent a team or switch casually to "we".
2. **Remove stock emphasis.** Cut "actually", "genuinely", "real", "plain", "honest" when the sentence is unchanged without them. Replace "seamless", "powerful", "robust", "complete" with a demonstrated behavior, or delete them. These are contextual edits, not banned tokens.
3. **Do not build paragraphs around contrasts.** Cut repeated "not X, but Y", unnamed-competitor stories, theatrical metaphors, rhetorical questions and punch-line endings. Keep a direct negative when it matters: "This demo cannot save changes."
4. **Explain once, in the right place.** Access once, provenance once, a limitation beside the feature it qualifies. Do not restate one point under several headings.
5. **Make interface language literal.** Action labels name the action. Error text says what failed, what still works and a real next step. Prefer "not recorded", "unavailable", "outside coverage" and "no results" to an unexplained dash when the states differ. Do not assign a cause the code cannot know.
6. **Separate display words from contracts.** Humanize status labels, not API keys, commands, JSON fields or stored data. Check that no script compares against a label before changing it.
7. **Keep precision.** Source years, units, model limits, coverage, read-only notices, provenance and privacy disclosures stay. Move dense detail to a disclosure or reference page rather than deleting it. Do not swap measured uncertainty for reassurance.
8. **Spelling and case.** American spelling and sentence case (see Writing Style). Preserve proper names, third-party quotations, file paths and valid attributes such as `aria-labelledby`. Match visible control text to its accessible name.
9. **No mechanical recipe for sounding human.** Do not strip every em dash, ban contractions or force one paragraph rhythm. Write ordinary sentences with enough detail to be useful.

Review by reading the finished page aloud and asking whether each sentence gives the visitor something they need. No detector or word list certifies the result.

## Validation Rules (TDD-Enforced)

The four prose rules formerly listed here (No Assumptions Beyond Source
Material, Unreleased Features Use Future/Pending Language, No Fabricated
Code Examples, Uncertainty Language for Pending Items) checked
`content/journal/` and were retired with that section — their tests
(`test_no_assumed_task_lists_without_disclosure` and three siblings) no
longer exist. The principles remain good style for journal-style writing;
they are no longer a CI gate.

`scripts/test_content_validation.py` now enforces one property: a published
data page must not advertise a dimension it has no data for. For
`content/quiet-corners.md` and its `static/data/quiet-corners/summary.json`
export — every advertised dimension (`stability`, `remoteness`,
`affordability`) and `sprawl_factor_coverage` entry must report non-zero
coverage once the page is non-draft (`test_quiet_corners_export_has_coverage_on_every_dimension`,
`test_sprawl_factor_coverage_has_no_dead_factors`).

The same file's `TestPublishedCopyRules` holds two copy rules. The site never
names its owner (first name, surname or initials) in anything Hugo builds
or copies, `static/data/` geodata excepted. Back Road Creative is linked from
About, and Go Move Shift only from Waypost, as what Waypost makes. There are
no clients, results or case studies, so none are claimed.

`scripts/copy_metrics.py <content/page.md>` is a stdlib-only prose check: word count, Flesch
reading ease, sentences over a word-count limit, body link count, and British spellings from the
American-spelling rule below (proper nouns, paths and quoted text exempt; see the script's
docstring; hits carry the line number). Its defaults are 800 words, FRE 60, 30 words per sentence
and at most 3 links; `--links N` demands exactly N. The only page it gates is
`content/driftless.md`: `scripts/validate.sh` and `pr-ci.yml` run it blocking with `--links 3`
(demo, repo, contact). Those limits are that page's gate, not a site-wide cap. Other pages,
including manuals and tool documentation, may be longer and carry more links.

## Writing Style

- **Verifiable claims** — include dates, versions, sources and quotes; state what the release, code or data shows
- **Plain studio voice** — direct, specific sentences; see Voice and Structure
- **Source facts only** — business, legal and biographical facts (location, dates, customers, prices, support promises) appear only where the repo already states them
- **Uncertainty stated** — pending, unreleased or unknown items say so; do not promise dates or features
- **American spelling** — color, license, organization, behavior, theater,
  judgment, labeled, artifact, analyze, normalize, optimization, not colour,
  licence, organisation, behaviour, theatre, judgement, labelled, artefact,
  analyse, normalise, optimisation. `-ize`/`-ization` over `-ise`/`-isation`,
  `-or` over `-our`. Applies to content/ prose and data/ blurbs (including the
  `_contract` doc block); proper nouns, product names, the `LICENSE` file/path,
  and quoted third-party text are exempt. HTML/ARIA attribute names are also
  exempt and must never be touched by a spelling sweep — `aria-labelledby` is
  a real attribute name, not a spelling choice.

## Release Notes

There is no on-site release section: release notes live on each project's GitHub
releases page (the hybrid redesign retired `content/releases/` and its generator
pipeline). The rigscore page stays version-truthful through data:
`scripts/check-rigscore-sync.js` and `scripts/verify-rigscore-toolpage.js` gate
`data/rigscore.json` (the file every rigscore fact on the site renders from) on
every PR.

## CI/CD Integration

Content validation runs before build:

```bash
# Run locally
pytest scripts/test_content_validation.py -v

# CI runs automatically on push to master
# Blocks deployment if validation fails
```

## Updating Rules

To add new validation rules:

1. Write test in `scripts/test_content_validation.py`
2. Verify test fails on known violations
3. Update this document with rule description
4. Commit both test and documentation

**TDD workflow:** Test → Documentation → Implementation

## Enforcement

- **Automated:** CI blocks deployment on validation failure
- **Pre-commit:** Run tests before pushing
- **Review:** Manual verification of source accuracy

---

*Content accuracy is non-negotiable. When in doubt, state less.*
