# 0008. `node-ts` project scaffold and detection

Status: accepted (2026-10-06)

## Context

The MVP success criterion starts from an empty folder, so `themis init` must create a project
when none exists. Existing projects must not be rewritten.

## Decision

- `init` requires a valid spec (default `spec.md`, or `--spec <path>`): invalid spec exits `1`.
- No `package.json`: scaffold a minimal project: `package.json` (ESM, private, scripts
  `typecheck`, `lint`, `test`), `tsconfig.json` (strict), `biome.json`, `vitest.config.ts`,
  `.gitignore` entries. Dev dependencies: `typescript`, `vitest`, `@types/node`,
  `@biomejs/biome`, at the versions Themis itself uses. Linter for generated projects: Biome.
- `package.json` present: detect only. Missing `typescript`, `vitest`, `tsconfig.json`, or
  `@biomejs/biome` when `lint` is enabled exits `2` with the list; nothing is written.
- `vitest.config.ts` (locked) wires `tests/acceptance/global-setup.ts` as `globalSetup` only if
  that file exists, so the locked acceptance harness can start infrastructure without editing
  the config, and disables file parallelism for acceptance files that share a database.
- Every generated file is idempotent: identical content is left alone, different content is
  skipped with a warning unless `--force`. `.gitignore` and `.claude/settings.json` are merged.
- `npm install` runs through the `Executor` after scaffolding, or when `node_modules` is
  missing, unless `--skip-install`; failure exits `2`.
- `init` warns, without failing, when the folder is not a git repository (worktrees and the
  guard's `base` diff need git).

## Consequences

- Support for existing projects is limited to ones already shaped like the scaffold.
- Dependency versions in the scaffold must be bumped together with Themis's own.
- Amended in M5 (2026-10-06): the scaffolded `biome.json` excludes `tests/acceptance/` from
  linting and formatting. Those files are locked, so a lint finding in them can never be fixed
  by a worker: the first real M5 run spent all four iterations on a Biome rule
  (`noControlCharactersInRegex`) violated by a locked test. Their quality is the human's call
  at the gate; type checking still covers them.
