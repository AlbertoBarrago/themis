# 0002. CLI argument parsing with `node:util` `parseArgs`

Status: accepted (2026-10-06)

## Context

The CLI has a handful of subcommands with few flags each. Libraries such as commander or
yargs add help generation and nested commands.

## Decision

Use the built-in `parseArgs` from `node:util`, with a small hand-written dispatcher
(`src/cli/run.ts`) and per-command help text. No dependency.

## Consequences

- Help text is written by hand and must be kept in sync with the options.
- Commands receive an injected `CliIo` (cwd, stdout, stderr) and return an exit code, so they
  are tested in-process without spawning Node.
- CLI exit codes mirror the verifier: `0` ok, `1` invalid input that can be fixed,
  `2` usage, I/O or internal error.
