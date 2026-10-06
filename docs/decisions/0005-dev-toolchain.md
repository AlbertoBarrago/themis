# 0005. Development toolchain: Biome, TypeScript, vitest

Status: accepted (2026-10-06)

## Context

These are development dependencies of Ordito itself, not of the projects Ordito generates.

## Decision

- Biome for linting and formatting (`biome check`): one fast binary that replaces ESLint and
  Prettier. `noExplicitAny` is an error.
- `typescript` for type checking and build, `vitest` for tests, `@types/node` pinned to the
  minimum supported Node major (22).

## Consequences

- `npm run check` runs typecheck, lint and tests; it is the local verifier for Ordito.
- The linter used by generated `node-ts` projects is a separate decision, taken in M1.
