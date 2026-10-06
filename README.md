# Themis

An open format and a reference CLI for spec-driven agentic development with a verification
loop.

Themis is the Titaness of divine law and order: she lays down what is right, and her scales
weigh what is done against it. In Themis, humans lay down the law: a `spec.md` with decisions
and acceptance criteria, plus locked acceptance tests that turn it into a contract. Agents do
the work: the code, iterated until a single impartial judge, the verifier, rules in its favour.

The point is not generating a plan. It is **guaranteeing convergence**: an immutable
contract, one verifier with semantic exit codes, guards against shortcuts, and a
retrospective loop that improves the agent configuration over time.

> Status: early development (milestone M4). The format is at version `0.1`.

## The format

[`SPEC_FORMAT.md`](SPEC_FORMAT.md) is the standard. It is meant to be useful without the CLI.
A complete example lives in [`examples/webhook-service/spec.md`](examples/webhook-service/spec.md).

```markdown
---
themis: 0.1
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
themis check [spec.md] [--json]   # validate a spec, every error with line, column and field
themis init [--spec <path>] [--force] [--skip-install]
themis plan [--spec <path>] [--force]   # planner agent -> draft .themis/tasks.json
themis approve plan                     # human gate
themis tests [--force]                  # test author -> tests/acceptance/ (draft)
themis approve tests [--force]          # human gate: lock the contract
themis run [task] [--executor lima]     # worker loop until the verifier passes
```

`init` scaffolds a node-ts project if the folder has no `package.json` (an existing project is
only checked, never rewritten), then generates:

- `.themis/verify.sh`: the verifier (`0` pass, `1` the code is wrong, `2` the environment is
  broken), with `.themis/guard.mjs` for the contract and forbidden-marker checks.
- `.themis/agents/`: planner, worker, reviewer and retro instructions.
- `.claude/settings.json` deny rules protecting the contract (agent adapter: Claude Code).

Exit codes: `0` ok (warnings allowed), `1` invalid spec, `2` usage, environment or I/O error.

`plan` sends the spec to the planner agent (`claude -p`, no tools, structured output), then
validates the graph against the spec: one task per criterion plus an optional `setup`, declared
dependencies kept, added ones justified, no cycles. Invalid answers are retried up to three
times. The planner's questions about the spec are classified: `blocking` ones (contradictory
or unverifiable criteria) stop `approve plan` until the spec is fixed; `minor` ones are left to
the workers.

`tests` asks the test author for acceptance tests; Themis checks paths, coverage (a
`describe("AC-<n>: ...")` per criterion) and forbidden markers before writing them.
`approve tests` re-checks the files on disk and records their digests, with the spec, verifier
and tool configuration, in `.themis/lock.json`: from then on the guard rejects any change.

`run` drives one task at a time: the worker agent edits the code, then Themis runs the
verifier itself; exit `1` feeds `.verify.log` into the next iteration, exit `2` blocks the task,
running out of `limits.max_iterations` fails it. State is saved after every step
(`.themis/state.json`), so a run can be interrupted and resumed.

### Running agents in a VM

Agents run arbitrary commands. `--executor lima` runs them, and the verifier, in a dedicated
[Lima](https://lima-vm.io) VM that only sees `~/themis-workspaces`:

```sh
scripts/lima/create-vm.sh            # once: VM "themis" with Node 22, git, Docker, Claude Code
limactl shell themis                 # once: run `claude` inside and log in
mkdir -p ~/themis-workspaces/app && cd ~/themis-workspaces/app   # projects live here
themis init --executor lima          # npm install happens in the VM (native binaries)
themis run --executor lima
```

Planned commands: `status`, `retro`.

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run check   # typecheck + lint (Biome) + tests (vitest)
npm run build
```

Design decisions are recorded in [`docs/decisions/`](docs/decisions/).
