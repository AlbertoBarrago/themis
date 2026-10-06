# 0012. Rename: Ordito becomes Themis

Status: accepted (2026-10-06)

## Context

The project started as "Ordito" (Italian for the warp threads of a loom). The name turned out
to be already in use elsewhere.

## Decision

- The project, CLI and format are now **Themis**, after the Titaness of divine law and order:
  humans lay down the law (spec and locked tests), agents do the work, and an impartial judge
  (the verifier) rules.
- Everything named after the project was renamed mechanically, with no compatibility layer
  (nothing has been released): the CLI binary `themis`, the project directory `.themis/`, the
  frontmatter key `themis: 0.1`, the `version` field of Themis files, environment variables
  `THEMIS_*`, template placeholders `__THEMIS_<KEY>__`.
- The npm name `themis` is taken; the package is `themis-spec` (confirmed), with the binary
  still called `themis`.
- ADRs written before the rename were updated in place to the new names, so the codebase and
  its records agree.

## Consequences

- Projects initialised with an earlier build must be re-initialised (`themis init`) and their
  spec frontmatter changed from `ordito:` to `themis:`.
- The GitHub repository was renamed to `AlbertoBarrago/themis`. The local folder keeps the old
  name until renamed by hand.
