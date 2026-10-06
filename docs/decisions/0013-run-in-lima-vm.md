# 0013. `themis run` (M4) and execution in a dedicated Lima VM

Status: accepted (2026-10-06)

## Context

Workers must edit files and run arbitrary shell commands (`npm install`, the verifier,
`docker compose`) without a human in the loop. On the host that means arbitrary code running
with the user's privileges, and the agent CLI also picks up the user's personal instructions
(`~/.claude/CLAUDE.md`). The user asked to run agents in a dedicated VM; Lima 2.2 (`vz`,
aarch64) is installed. Principle 6 already anticipates a sandboxed `Executor`.

## Findings (Claude Code 2.1.290)

- `claude -p --setting-sources project,local` does not load the user's global CLAUDE.md
  (probe: asked about language instructions, none reported), and authentication still works.
  The adapter passes it on every call, host or VM.

## Decision

### `LimaExecutor`

- Themis runs on the host; every command goes through `LimaExecutor`, which wraps it as
  `limactl shell --tty=false --workdir <cwd> <instance> -- <command> <args...>`, stdin passed
  through. Selected with `--executor lima` (default instance `themis`, or
  `THEMIS_LIMA_INSTANCE`); `local` stays the default for `init`, `plan` and `tests`.
- Lima mounts host paths at the same path in the guest, so `cwd` and every path Themis
  computes are valid on both sides. Only the workspace directory is mounted, writable.

### Dedicated VM

- New instance `themis` (existing `dev` and `riccio-vm` are never touched), from
  `template:docker` (Docker for the `infra` step), 4 CPUs, 8 GiB, `--mount-none` plus one
  writable mount: `~/themis-workspaces`. Projects run by agents must live there.
- Provisioned with Node 22, git and Claude Code. The user authenticates Claude Code once inside
  the VM (`limactl shell themis` then `claude`); the VM has its own home, so no personal
  instructions exist there.
- A script `scripts/lima/create-vm.sh` (plus its template) makes this reproducible.

### `themis run [task]` (sequential, single task)

- Requires an approved plan and a locked contract (`.themis/lock.json`).
- Runs the given task, or the first task whose dependencies are `done`, through the state
  machine `pending -> running -> verifying -> done`, `failed` (iterations exhausted),
  `blocked` (verifier exit `2`). State in `.themis/state.json`, rewritten after every step.
- Each iteration: one worker call (role `worker`, tier `models.worker`, edit tools) with the
  task, the decisions, the minor questions to decide and record, and the previous
  `.verify.log`. Then **Themis itself** runs `.themis/verify.sh <task>` through the executor:
  the worker's own claims are never trusted.
- Worker tools: Read, Edit, Write, Grep, Glob, Bash, with `--permission-mode acceptEdits`
  and Bash allowed, plus the per-call deny rules. To be verified with a test call before
  coding the adapter change.
- Every worker call and verifier run is logged under `.themis/runs/<task>/`.
- No commits in M4: worktrees, merges and the reviewer arrive in M5.

## Findings while implementing

- `limactl create` rejects `--mount-none` together with `--mount`; the script replaces the
  template's mount list with `--set '.mounts = [...]'` instead.
- `limactl shell ... -- env K=V bash -lc 'exec "$@"' themis <cmd> <args>` preserves arguments
  exactly (probed with spaces, quotes, `$`, `;`, newlines and JSON), as well as `--workdir`,
  environment and stdin. A missing command exits `127`.
- Worker permissions probed on the host: with `--permission-mode acceptEdits --allowedTools
  Bash` and inline deny rules, Write and Bash work, while Edit, `echo > file` and `cp` onto a
  protected path are all denied and reported in `permission_denials`.
- `node_modules` must be installed by the platform that runs the verifier (Biome, rolldown
  and friends ship native binaries), so `themis init` also takes `--executor lima`. A project
  initialised in the VM is then verified in the VM only.
- Claude Code in the VM needs its own login (`limactl shell themis`, then `claude`).
