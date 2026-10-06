# 0001. Runtime: Node.js 22+, TypeScript, ESM

Status: accepted (2026-10-06)

## Context

Ordito ships as the npm package `ordito`. Its first supported stack is `node-ts`, so users
already have Node.js installed.

## Decision

- Target Node.js 22 or later (`engines.node: ">=22"`), ESM only (`"type": "module"`).
- TypeScript in strict mode, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
  compiled with `tsc` to `dist/`. No bundler.
- Tests with vitest.

## Consequences

- No CommonJS build; consumers must use ESM. Acceptable for a CLI-first package.
- Node 22 gives `node:util` `parseArgs`, `fs/promises` and top-level await without polyfills.
