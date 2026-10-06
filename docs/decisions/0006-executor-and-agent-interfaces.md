# 0006. Executor and agent adapter interfaces

Status: accepted (2026-10-06)

## Context

Principles 5 and 6: the CLI never calls LLM APIs and never depends on Claude Code outside its
adapter; every command execution must be isolatable in a sandbox later without touching the
orchestrator. M1 needs to run `npm install` and to install agent-side write protections.

## Decision

- `Executor` (`src/runtime/executor.ts`): `exec({ command, args, cwd, env?, timeoutMs?, stdin? })`
  resolves to `{ exitCode, signal, stdout, stderr, timedOut, durationMs }`. Never uses a
  shell. A command that cannot be spawned (`ENOENT`) rejects with `ExecError` of kind
  `not-found`; a non-zero exit is a normal result, not an error.
- `LocalExecutor` implements it with `child_process.spawn`; on timeout it sends `SIGTERM`, then
  `SIGKILL` after a grace period. Output is capped to avoid unbounded memory.
- Agent adapters are split by capability (interface segregation):
  - `GuardInstaller` (M1): `installGuards(root, { protectedPaths })` writes the agent-specific
    protections (for Claude Code, `permissions.deny` in `.claude/settings.json`, merged with
    existing settings, never overwriting unrelated keys). Rules use `Edit(/<path>)`: the `/`
    prefix anchors the path to the settings file's project root, and `Edit` covers every
    built-in file-editing tool (Write, MultiEdit, NotebookEdit). Source:
    https://code.claude.com/docs/en/permissions.md
  - `AgentRunner` (brought forward to M2, see ADR 0009): runs one agent invocation through an `Executor`, so a sandboxed
    executor also sandboxes the agent.
- Adapters are looked up by name (`--agent claude-code`, the default) in one registry; no other
  module imports `src/adapters/claude-code`.

## Consequences

- Per the Claude Code docs, project `.claude/settings.json` deny rules are not applied by
  `claude -p` in a workspace that has not been trusted. The M4 `AgentRunner` must therefore
  pass the same rules explicitly on every invocation, and not rely on the project file alone.
  Confirmed by test calls in ADR 0009 (inline `--settings` with `./`-prefixed rules).

- Agent-side protections are defense in depth only: an agent can still write files through a
  shell. The guard step of the verifier (ADR 0007) is the actual enforcement.
- Tests use `FakeExecutor` and a fake `GuardInstaller`; no test spawns `claude`.
