# 0015. `themis status`, `themis retro` and `themis approve retro` (M6)

Status: accepted (2026-10-06)

## Context

`themis run` leaves its history in `.themis/state.json` and `.themis/runs/`, but nothing reads
it back: the user has no overview short of opening JSON, and the third human gate of
`SPEC_FORMAT.md` (approval of configuration changes proposed by a retrospective) has no command.

## Decision

### `themis status [--spec <path>] [--json]`

Read-only: no agent call, no write. It reports:

- the gates: spec valid or not; plan absent, draft, approved, or approved for another spec
  (stale); contract absent, draft, locked, or locked with files that no longer match their
  digest in `.themis/lock.json`;
- per task (plan order): status, iterations of the current attempt against
  `limits.max_iterations`, iterations in total, cost, and why the task is failed or blocked,
  or what went wrong in its last iteration;
- totals (iterations, cost) and whether a retrospective proposal is pending.

`--json` prints the same report as JSON. Exit `0` whenever a report was produced, whatever the
state of the run; `2` when a Themis file exists but cannot be read. Exit codes describing the
run belong to `themis run`.

### `themis retro`

1. Preconditions: `.themis/agents/retro.md` exists, the spec is valid (for `models.retro`), and
   at least one task is done, failed or blocked. Otherwise exit `2`.
2. Themis extracts the **evidence** deterministically from `.themis/state.json`, plus the
   permission denials recorded in the worker logs under `.themis/runs/<task>/` (logs that are
   missing are skipped; logs that cannot be parsed are reported as warnings). Each item has a
   stable id:
   - `<task>#<n>:verify` verifier failure at a step, `<task>#<n>:review` changes requested,
     `<task>#<n>:reverted` merged result failed the verifier, `<task>#<n>:conflict` merge
     conflict, `<task>#<n>:worker` worker call failed, `<task>#<n>:denied` tool calls refused
     by the protections;
   - `<task>:failed`, `<task>:blocked` with the reason, `<task>:choice-<k>` minor decisions.

   With no evidence (every task done at the first iteration, nothing decided), Themis does not
   call the agent and reports that there is nothing to improve.
3. One structured call (role `retro`, tier `models.retro`, read-only tools, up to 3 attempts
   with the rejection reasons, logged under `.themis/runs/retro/`). The prompt carries the
   evidence and the current instruction files. Answer:
   `{ proposals: [{ role, pattern, evidence: [id], edits: [{ old, new }] }] }`, possibly empty.
4. Validation, since agent output is never trusted:
   - `role` is `planner`, `test-author`, `worker` or `reviewer`. The retro agent cannot edit
     its own instructions, and by construction nothing else: not the spec, the tests, the
     verifier, the guard or tool configuration;
   - every evidence id exists;
   - edits apply in order, per file, across proposals: each `old` is non-empty and occurs
     exactly once in the file as left by the previous edits, and `new` differs from it.
5. The proposal is written to `.themis/runs/retro.json` (git-ignored, so a pending proposal
   never dirties the tree `themis run` requires clean) with the sha256 of each target file as
   it was. The CLI prints each proposal with its pattern, evidence and a unified diff
   (`git diff --no-index` through the executor, no new dependency).

### `themis approve retro`

The third gate, all or nothing: to drop a proposal, edit `.themis/runs/retro.json` or run
`themis retro` again. It refuses (exit `1`) when a target file changed since the proposal,
re-applies the edits with the same rules, writes the files, removes the proposal, and prints
the `git` commands to commit them. Themis does not commit: the user owns the agent
configuration as much as the spec.

## Consequences

- Instruction files changed by the retrospective are not part of the lock (ADR 0011), so a
  retro never invalidates the contract; the guard does not scan `.themis/`.
- Evidence is limited to what Themis records: the full verifier log of each iteration is not
  kept, only the failing step.
