<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" width="112" alt="Themis logo: a pair of scales">
  </picture>
</p>

<h1 align="center">Themis</h1>

<p align="center">
  <strong>Humans lay down the law. Agents do the work. One verifier judges.</strong><br>
  An open format and a reference CLI for spec-driven agentic development with a verification loop.
</p>

<p align="center">
  <a href="https://albz.it/themis/"><img alt="Website" src="https://img.shields.io/badge/website-albz.it%2Fthemis-8a5a1f"></a>
  <a href="https://github.com/AlbertoBarrago/themis/wiki"><img alt="Wiki" src="https://img.shields.io/badge/docs-wiki-8a5a1f"></a>
  <a href="SPEC_FORMAT.md"><img alt="Spec format v0.1" src="https://img.shields.io/badge/spec%20format-v0.1-8a5a1f"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-5f584e">
  <img alt="Status: early development" src="https://img.shields.io/badge/status-early%20development-5f584e">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/AlbertoBarrago/themis?color=5f584e"></a>
  <a href="https://github.com/AlbertoBarrago/themis/actions/workflows/pages.yml"><img alt="Site deploy" src="https://github.com/AlbertoBarrago/themis/actions/workflows/pages.yml/badge.svg"></a>
</p>

Themis is the Titaness of divine law and order: she lays down what is right, and her scales
weigh what is done against it. In Themis, humans lay down the law: a `spec.md` with decisions
and acceptance criteria, plus locked acceptance tests that turn it into a contract. Agents do
the work: the code, iterated until a single impartial judge, the verifier, rules in its favour.

The point is not generating a plan; other tools do that. The point is **guaranteeing
convergence**: an immutable contract, one verifier with semantic exit codes, guards against
shortcuts, a reviewer against scope creep, and a retrospective loop that improves the agent
configuration over time.

> Status: early development. Milestones M0 to M6 are done (format, init, plan, tests, run with
> worktrees, review and parallelism, status and retrospective). The format is at version
> `0.1`. Not published to npm yet.

Inspired by Boris Cherny's advice to give Claude a way to verify its work
([why](https://github.com/AlbertoBarrago/themis/wiki/Inspiration)).

## How it works

```
 you write spec.md        decisions + acceptance criteria
        │
 themis init              generates the judge: verifier + guard (no AI involved)
        │
 themis plan              planner agent → task graph, checked against the spec
        │                 + questions about ambiguities in the spec
 themis approve plan      GATE 1: does the plan make sense?
        │
 themis tests             test-author agent → acceptance tests, checked for coverage
 themis approve tests     GATE 2: is this what I want? → tests locked by digest
        │
 themis run               per task, in its own git worktree, no human involved:
                          worker edits → Themis verifies → reviewer reads the diff
                          → merge → full verification of the branch
        │
 themis retro             retro agent → changes to the agents' instructions, each
        │                 citing the run evidence it addresses
 themis approve retro     GATE 3: apply them
```

Three human gates, and only three. You decide **what** (the spec) and **when it is done** (the
locked tests); agents decide **how** (the code); the verifier decides **whether they did it**.

The second gate matters most: once the tests are locked, "done" means `.themis/verify.sh`
exits `0`, and nobody needs to ask you again.

## Requirements

- Node.js 22 or later and git.
- [Claude Code](https://claude.com/claude-code), logged in: the only agent adapter so far.
  Themis never calls an LLM API itself; it drives the agent CLI.
- Optional but recommended: [Lima](https://lima-vm.io), to run agents in a dedicated VM.

## Installation

Themis is not on npm yet (the package will be `themis-spec`, the command `themis`). From a
clone:

```sh
npm install
npm run build
npm link            # puts `themis` on your PATH
```

## Quick start

```sh
mkdir greeter && cd greeter && git init -b main
$EDITOR spec.md                   # see "The format" below

themis check                      # every problem with line, column and field
themis init                       # scaffolds a node-ts project if the folder is empty

themis plan                       # planner agent proposes the task graph
themis approve plan               # gate 1

themis tests                      # test-author agent writes tests/acceptance/
                                  # read them; you may edit them before approving
git add -A && git commit -m "themis contract"
themis approve tests              # gate 2: the contract is locked
git add -A && git commit -m "lock contract"

themis run                        # runs the whole graph until every task is done
themis status                     # gates, tasks, iterations, cost

themis retro                      # retro agent proposes changes to the agents' instructions
themis approve retro              # gate 3: apply them, then commit .themis/agents/
```

A real run on a three-criterion library (the reviewer catches scope creep, two tasks run in
parallel, the worker resolves a merge conflict):

```
AC-1 iteration 1: review asked for changes ($0.0868):
    - Scope creep: custom-separator support belongs to AC-2, and no AC-1 test uses it.
AC-1 iteration 2: review approved ($0.0644); merging...
AC-1: merged and verified
AC-2: starting
AC-3: starting
AC-2: merged and verified
AC-3: merge conflict on src/slug.ts; the worker will resolve it
AC-3 iteration 2: verify PASS; reviewing...
AC-3: merged and verified
AC-1: done after 2 iterations, $0.2396
AC-2: done after 1 iteration, $0.0627
AC-3: done after 2 iterations, $0.2212
```

## Running agents in a VM

Workers edit files and run arbitrary shell commands. `--executor lima` runs them, together with
git, npm and the verifier, in a dedicated Lima VM that sees nothing of your machine except
`~/themis-workspaces`:

```sh
scripts/lima/create-vm.sh            # once: VM "themis" with Node 22, git, Docker, Claude Code
limactl shell themis                 # once: run `claude` inside and log in, then exit

mkdir -p ~/themis-workspaces/app && cd ~/themis-workspaces/app   # projects live here
themis init --executor lima          # npm install runs in the VM (native binaries differ)
themis run --executor lima
```

Gates (`plan`, `tests`) can run on the host. A project initialised in the VM is verified in
the VM only.

## The format

[`SPEC_FORMAT.md`](SPEC_FORMAT.md) is the standard, and it is meant to be useful without the
CLI. A complete example, a webhook ingestion service with persistence, deduplication, retries
and a dead-letter state, lives in
[`examples/webhook-service/spec.md`](examples/webhook-service/spec.md).

```markdown
---
themis: 0.1
stack: node-ts
verify: [typecheck, lint, unit, acceptance]
limits: { max_iterations: 5, parallel: 3 }
models: { planner: strong, worker: fast, reviewer: strong }
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

- `## Decisions` are choices the agents must respect, never reopen. Since tests are written
  before any code exists, the decisions should fix the public interface the tests rely on.
- Each `## AC-<n>` is a node of the task graph and a group of acceptance tests named
  `AC-<n>: ...`. `Depends:` is optional; without it the planner may infer dependencies, which
  you approve at gate 1.
- Model tiers (`strong`, `fast`) are abstract; the agent adapter maps them to concrete models.

## CLI reference

| Command | What it does |
| --- | --- |
| `themis check [spec] [--json]` | Validates a spec; every diagnostic has a line, a column, a stable code and, for frontmatter, the field path. |
| `themis init [--spec <path>] [--executor local\|lima] [--force] [--skip-install]` | Scaffolds an empty folder (or checks an existing project) and generates `.themis/` and the agent protections. |
| `themis plan [--spec <path>] [--force]` | Planner agent, no tools, structured output. Themis checks the graph: one task per criterion plus an optional `setup`, declared dependencies kept, added ones justified, no cycles. |
| `themis approve plan [--force]` | Gate 1. Refuses if the spec changed, or if the planner raised `blocking` questions (unless `--force`). |
| `themis tests [--force]` | Test-author agent, read-only tools. Themis writes the files after checking paths, coverage and forbidden markers. |
| `themis approve tests [--force]` | Gate 2. Re-checks the files on disk, then records the digests of the tests, spec, verifier and tool configuration in `.themis/lock.json`. |
| `themis run [task] [--executor local\|lima]` | Runs the whole graph, or one task. See below. |
| `themis status [--json]` | Read-only report: gates (spec, plan, contract, including locked files changed since), and per task its status, iterations against the budget, cost and what went wrong. Exits `0` whenever it can report. |
| `themis retro` | Retro agent, read-only tools. See below. |
| `themis approve retro` | Gate 3. Applies the proposal, unless an instruction file changed since it was made. Themis does not commit the result. |

Questions agents raise about the spec are either `blocking` (contradictory or unverifiable
criteria: fix the spec) or `minor` (details a worker decides and records; later tasks receive
those decisions as constraints).

### `themis run`

Each task works in its own git worktree (`.themis/worktrees/<task>`, branch `themis/<task>`),
up to `limits.parallel` at once. Every iteration:

1. syncs the worktree with the current branch, so work merged meanwhile is present (a
   conflict is handed to the worker to resolve);
2. the worker agent edits the code;
3. Themis runs the verifier itself on the task's criterion plus the criteria already merged;
   exit `1` feeds `.verify.log` into the next iteration, exit `2` blocks the task;
4. a reviewer agent reads the committed diff and approves, or asks for changes (scope creep,
   faked behaviour, broken decisions), which costs an iteration;
5. Themis merges into the current branch and runs the verifier there; if the combination
   fails, it undoes its own merge and the task goes on. A merge conflict also goes back to
   the worker.

A task fails when it runs out of `limits.max_iterations`. State is written atomically after
every step (`.themis/state.json`): interrupt with Ctrl-C and run again to resume. The working
tree must be clean and the locked contract committed before `run`; Themis never commits your
changes and only ever undoes a merge it has just made.

### `themis retro`

Themis extracts the evidence of the run from `.themis/state.json` and the worker logs, each
item with a stable id (`AC-2#1:review` reviewer objection at iteration 1, `AC-1#1:verify`
verifier failure, `AC-2:failed`, `AC-1:choice-1`, ...). With no evidence it does not call the
agent. The retro agent proposes text replacements in the planner, test-author, worker or
reviewer instructions, each with the pattern it addresses and the evidence ids. Themis
rejects proposals that target any other file (its own instructions included), cite unknown
evidence, or whose text does not match exactly once. The proposal is written to
`.themis/runs/retro.json` and printed as a diff; nothing changes until `themis approve retro`.

### Exit codes

Every command, and the verifier, uses the same convention:

| Code | Meaning |
| --- | --- |
| `0` | Success (warnings allowed). |
| `1` | Something fixable is wrong: an invalid spec, failing code, a failed task. |
| `2` | The environment or the invocation is broken: missing tool, bad arguments, blocked task. A loop stops instead of retrying. |

## What Themis generates

```
.themis/
  verify.sh          the verifier: guard, typecheck, lint, unit, infra, migrate, acceptance
  guard.mjs          locked-file digests and forbidden-marker scan
  agents/            planner, test-author, worker, reviewer, retro instructions
  tasks.json         the plan (draft or approved)
  tests.json         the acceptance-test gate
  lock.json          sha256 of every file in the contract
  state.json         run state, per task and iteration (git-ignored)
  runs/              every agent call: result, tokens, cost; retro.json, the pending
                     retrospective proposal (git-ignored)
  worktrees/         one checkout per running task (git-ignored)
.claude/settings.json  deny rules on the contract, for interactive sessions
```

## Guarantees

- **One judge.** Only the verifier's exit code moves a task. Themis runs it itself; what an
  agent claims never counts.
- **An immutable contract.** Any change to a locked file fails the guard, and so does any
  `.only(`, `.skip(`, `.todo(`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `as any` or
  linter suppression added after the lock.
- **Protections per call.** Every agent invocation carries deny rules on the contract, and
  agents run without your personal Claude Code instructions (`--setting-sources
  project,local`).
- **Agent output is never trusted.** Plans, tests and verdicts are validated mechanically
  before they reach you or the repository.
- **Isolation, when you want it.** With `--executor lima`, agents only see
  `~/themis-workspaces`.

## Development

```sh
npm install
npm run check   # typecheck + lint (Biome) + tests (vitest)
npm run build
```

The code is TypeScript (strict, ESM) with two runtime dependencies, `yaml` and `zod`. Every
design decision not covered by `SPEC_FORMAT.md` is recorded in
[`docs/decisions/`](docs/decisions/), including what real runs taught along the way.

## License

MIT
