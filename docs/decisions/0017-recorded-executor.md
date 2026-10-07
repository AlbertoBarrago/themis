# 0017. `themis init` records its executor

Status: accepted (2026-10-07)

## Context

`node_modules` holds native binaries for the platform that installed it: TypeScript 7 and
Biome ship one package per platform. ADR 0013 asked users to pass the same `--executor` to
`init` and `run`, but nothing enforced it. In a real run, `init --executor lima` installed the
Linux binaries and `run` (default `local`) worked on macOS: every task worktree installed its
own macOS binaries and passed, then the verifier on the merged branch crashed in `tsc`. The
crash was reported as a type error (exit 1), so the task spent its whole budget on an
environment problem.

## Decision

- `themis init` writes `.themis/local.json`, `{ "executor": "local" | "lima" }`. It is
  git-ignored: it describes how this checkout was set up, not the project.
- Every command that takes `--executor` picks the flag, else the recorded executor, else
  `local`. `themis init` without the flag keeps the recorded one.
- `themis run` refuses (exit 2) an `--executor` other than the recorded one, explaining how to
  switch: remove `node_modules` (also in the task worktrees), then `themis init` with the new
  executor.
- `themis init` with another executor refuses (exit 2) while `node_modules` exists, and writes
  nothing. Without `node_modules` it switches and records the new executor.
- A project without the file (initialised earlier) behaves as before: `local` by default.

## Consequences

- `themis run` no longer needs `--executor lima` after `themis init --executor lima`.
- A tool crash reported as a code failure remains possible for other causes; the verifier
  telling them apart is a separate change.
