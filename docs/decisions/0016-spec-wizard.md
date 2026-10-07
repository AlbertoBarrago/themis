# 0016. `themis new`: a spec skeleton with a terminal wizard

Status: accepted (2026-10-07)

## Context

Every project starts from an empty `spec.md`, and the only references are `SPEC_FORMAT.md` and
the examples. Starting from a copy means deleting someone else's decisions and criteria first,
and a frontmatter typo is caught only by `themis check`.

## Decision

`themis new [spec] [--yes] [--force]` writes a spec skeleton (default `spec.md`) that passes
`themis check`. Everything it cannot know is a `<...>` placeholder: the summary when left
empty, the decisions, and the Given / When / Then clauses of each criterion.

- **Wizard.** In a terminal it asks for the title (default: the folder name), a one-line
  summary, the `verify` steps, `max_iterations`, `parallel`, then the criteria one by one with
  their `Depends:`. An invalid answer is explained and asked again. Dependencies may only name
  earlier criteria, so the graph is acyclic by construction.
- **Defaults.** `verify: [typecheck, lint, unit, acceptance]` and
  `limits: { max_iterations: 3, parallel: 2 }`, lower than the format defaults (5 and 3)
  because a first spec is usually a trial run, where iterations cost money.
- **No terminal.** When stdin is not a TTY, or with `--yes`, it writes the skeleton with the
  defaults and says so, instead of waiting on input that never comes. This keeps it usable
  from scripts and agents.
- **Safety.** An existing file is refused before the first question unless `--force`, and the
  write uses `wx` so nothing created meanwhile is overwritten. Ctrl+C or Ctrl+D aborts with
  exit `2` and writes nothing.
- **No dependency.** Prompts use `node:readline`, behind an optional `prompt` on `CliIo`,
  so tests inject answers. One interface serves every question and queues the lines it reads:
  pasted answers arrive in one chunk, and a fresh interface per question loses all but the
  first line.

## Consequences

- `themis check` accepts a skeleton whose placeholders are still there; an unfinished spec is
  noticed only when the planner raises questions. A placeholder warning in `themis check` is a
  possible follow-up.
- The renderer (`src/spec/template.ts`) is pure and tested against the parser, so a format
  change that breaks the skeleton fails the test suite.
