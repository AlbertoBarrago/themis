# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

(Formerly "Ordito"; renamed to Themis, see ADR 0012. The npm package is
`themis-spec`, the binary is `themis`.)

Themis is an open format (`SPEC_FORMAT.md`, version `0.1`) plus a reference CLI (npm package
`themis`) for spec-driven agentic development with a verification loop. Humans own the spec
and the locked acceptance tests; agents produce code until a single verifier passes.

`SPEC_FORMAT.md` is normative and must stay usable without the CLI. When parser behavior
changes, update `SPEC_FORMAT.md` (including the diagnostic code table in section 7) in the
same change, and keep `DiagnosticCode` in `src/spec/diagnostics.ts` in sync with it.

## Commands

```sh
npm run check                      # typecheck + Biome + vitest: the local verifier, must be clean
npm run typecheck                  # tsc --noEmit
npm run lint                       # biome check .
npx biome check --write .          # apply Biome fixes and formatting
npm test                           # vitest run
npx vitest run tests/spec/body.test.ts        # single file
npx vitest run -t "reports a duplicate title" # single test by name
npm run build && node dist/cli/main.js check examples/webhook-service/spec.md
```

## Architecture

- `src/spec/parse.ts` `parseSpec(source)` is the entry point. It runs `frontmatter.ts`, then
  `body.ts`, then `validate.ts`, and always collects every diagnostic instead of stopping at the
  first one. The body is analysed even when the frontmatter is invalid. `spec` is returned only
  when there are no errors (warnings allowed).
- `frontmatter.ts`: YAML via the `yaml` document model so every node keeps a source range;
  zod issue paths are resolved back to line/column. `themis:` is checked against its raw source
  text (so `0.10` is not `0.1`). Unknown top-level keys are checked by hand to allow `x-*`
  extensions; nested objects use `strictObject`. Error messages are rewritten in
  `describeIssue` so they do not depend on zod's wording.
- `body.ts`: a deliberately minimal line-based parser, not a CommonMark parser. Only ATX `#` and
  `##` outside fenced code blocks carry structure. It returns `ParsedCriterion` (with
  `dependsRefs` positions) which `parse.ts` strips before exposing `Spec`.
- `validate.ts`: cross-section rules (duplicate ids, unknown/self dependencies, cycles via
  `src/graph/dag.ts`). `depends: null` means "no `Depends:` line" (planner may infer),
  `[]` means `Depends: none`.
- CLI: `src/cli/run.ts` `runCli(argv, io)` dispatches commands and returns an exit code;
  `main.ts` is the only place touching `process`. Commands take an injected `CliIo` so tests run
  in-process. Arguments are parsed with `node:util` `parseArgs` (no CLI library).
- `themis init` (`src/init/init.ts`) validates everything before writing: spec, then project
  detection (`src/stack/node-ts/detect.ts`), then agent guards, then generated files. Generated
  files go through `writeGenerated` (`src/fs/generated.ts`): identical content is left alone,
  different content is skipped unless `--force`.
- `templates/` ships with the package and is read at runtime via `src/templates.ts`
  (placeholders `__THEMIS_<KEY>__`). `templates/node-ts/verify.sh` and `guard.mjs` are the
  generated verifier; `guard.mjs` is plain JS type-checked through `checkJs`. Their behavior
  is specified in ADR 0007 and tested by running them for real (`tests/stack/`, with stub
  binaries; `tests/e2e/` with the real toolchain via Themis's own `node_modules`).
- Process execution goes through `Executor` (`src/runtime/`); agent-specific code lives only
  in `src/adapters/<agent>/` and is reached through `src/adapters/registry.ts`.
- Exit codes everywhere mirror the verifier contract: `0` ok, `1` fixable input/code problem,
  `2` usage, environment or internal error.

## Planned design constraints (milestones M1 to M6)

- The CLI never calls LLM APIs directly: agents run through an `AgentRunner` interface (only a
  Claude Code adapter in the MVP; no other module may depend on Claude Code). Agent-specific
  protections such as `.claude/settings.json` are installed by the adapter, not by core code.
- `ClaudeCodeRunner` (`src/adapters/claude-code/runner.ts`) passes protections on every call as
  inline `--settings` with `./`-prefixed rules: inline `Edit(/x)` is NOT enforced (ADR 0009).
  Agents run with `--setting-sources project,local`, so the user's global CLAUDE.md does not
  reach them (ADR 0013), but the target repo's CLAUDE.md does: prompts must still state
  anything that must not be overridden (e.g. output language). JSON Schemas sent with
  `--json-schema` must not carry a `$schema` key.
- `themis run` (`src/run/run.ts`, ADR 0014): scheduler plus per-task state machine
  (worker, verify, review, merge, post-merge verify with self-undo). Git goes through
  `src/git/git.ts` and the executor; main-tree operations are serialised by `#withMain`, state
  writes by `#save`. Tests use real git via `tests/fakes/router.ts`. `LimaExecutor` (`src/runtime/lima-executor.ts`) runs
  commands in the VM via `limactl shell ... bash -lc 'exec "$@"'` (no quoting needed);
  `scripts/lima/create-vm.sh` builds the VM. Never touch the user's other Lima instances.
- Agent output is never trusted: `src/plan/validate.ts` checks the planner's graph against the
  spec before anything reaches the human gate.
- Orchestrator logic must be testable with `FakeAgentRunner` and `FakeExecutor`.
- Verify `claude` CLI flags and output format with `claude --help` and a test call before writing
  the adapter; do not assume them.

## Conventions

- Every runtime dependency needs an ADR in `docs/decisions/`. Design choices not covered by
  `SPEC_FORMAT.md` or the ADRs need a short ADR and user confirmation first.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: build
  optional fields conditionally instead of assigning `undefined`. ESM imports use `.js` suffixes.
- Tests build fixtures with the `lines(...)` helper in `tests/helpers.ts` so line numbers in
  assertions are countable.
- VCS is `jj` colocated with git, with one bookmark per milestone (`m0-spec-format`, ...).
  Each milestone ends with green `npm run check`, a summary, and a stop for user approval
  before describing/committing.
