# Ordito

An open format and a reference CLI for spec-driven agentic development with a verification
loop.

In weaving, the *ordito* (warp) is the set of fixed threads on the loom and the *trama*
(weft) is what gets woven through them. In Ordito, humans own the warp: a `spec.md` with
decisions and acceptance criteria, plus locked acceptance tests that turn it into a contract.
Agents produce the weft: the code, iterated until a single objective verifier passes.

The point is not generating a plan. It is **guaranteeing convergence**: an immutable
contract, one verifier with semantic exit codes, guards against shortcuts, and a
retrospective loop that improves the agent configuration over time.

> Status: early development (milestone M3). The format is at version `0.1`.

## The format

[`SPEC_FORMAT.md`](SPEC_FORMAT.md) is the standard. It is meant to be useful without the CLI.
A complete example lives in [`examples/webhook-service/spec.md`](examples/webhook-service/spec.md).

```markdown
---
ordito: 0.1
stack: node-ts
verify: [typecheck, lint, unit, acceptance]
---

# Greeting service

## Decisions
- `src/greet.ts` exports `greet(name: string): string`.

## AC-1 Greets by name
Depends: none
- Given the name "Ada"
- When greet is called
- Then it returns "Hello, Ada"
```

## CLI

```sh
ordito check [spec.md] [--json]   # validate a spec, every error with line, column and field
ordito init [--spec <path>] [--force] [--skip-install]
ordito plan [--spec <path>] [--force]   # planner agent -> draft .ordito/tasks.json
ordito approve plan                     # human gate
ordito tests [--force]                  # test author -> tests/acceptance/ (draft)
ordito approve tests [--force]          # human gate: lock the contract
```

`init` scaffolds a node-ts project if the folder has no `package.json` (an existing project is
only checked, never rewritten), then generates:

- `.ordito/verify.sh`: the verifier (`0` pass, `1` the code is wrong, `2` the environment is
  broken), with `.ordito/guard.mjs` for the contract and forbidden-marker checks.
- `.ordito/agents/`: planner, worker, reviewer and retro instructions.
- `.claude/settings.json` deny rules protecting the contract (agent adapter: Claude Code).

Exit codes: `0` ok (warnings allowed), `1` invalid spec, `2` usage, environment or I/O error.

`plan` sends the spec to the planner agent (`claude -p`, no tools, structured output), then
validates the graph against the spec: one task per criterion plus an optional `setup`, declared
dependencies kept, added ones justified, no cycles. Invalid answers are retried up to three
times. The planner's questions about the spec are classified: `blocking` ones (contradictory
or unverifiable criteria) stop `approve plan` until the spec is fixed; `minor` ones are left to
the workers.

`tests` asks the test author for acceptance tests; Ordito checks paths, coverage (a
`describe("AC-<n>: ...")` per criterion) and forbidden markers before writing them.
`approve tests` re-checks the files on disk and records their digests, with the spec, verifier
and tool configuration, in `.ordito/lock.json`: from then on the guard rejects any change.

Planned commands: `run`, `status`, `retro`.

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run check   # typecheck + lint (Biome) + tests (vitest)
npm run build
```

Design decisions are recorded in [`docs/decisions/`](docs/decisions/).
