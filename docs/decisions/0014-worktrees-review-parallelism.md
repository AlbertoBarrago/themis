# 0014. Worktrees, reviewer, parallelism and resume (M5)

Status: accepted (2026-10-06)

## Context

M4 ran one task in the main working tree, with no review. The first real run (slug demo)
showed the gap: the AC-1 worker also implemented AC-2 and AC-3, which no verifier can detect
because their tests pass too.

## Decision

### Preconditions

`themis run` requires a git repository whose working tree is clean (ignoring Themis's own
ignored files) and whose `HEAD` contains the locked contract (`.themis/lock.json`, tests,
spec, verifier). Otherwise it refuses with the exact `git` commands to run. Themis never
commits user changes it did not make.

### One worktree per task

- `git worktree add .themis/worktrees/<task> -b themis/<task> <working-branch HEAD>`.
  `.themis/worktrees/` is git-ignored and inside the project, so it is visible in the VM.
- Themis runs `npm install` in the new worktree through the executor (native binaries, and
  the worker may add dependencies).
- The worker and the verifier run with the worktree as `cwd`. State stays in the main tree's
  `.themis/state.json`.

### State machine

`pending -> running -> verifying -> reviewing -> merging -> done`, plus `failed` (budget
exhausted, or merge conflict) and `blocked` (verifier exit 2, agent unavailable).

1. `running`: worker call (prompt now says: implement only this task; decisions already taken
   by other tasks on minor questions are passed as constraints, not as open questions).
2. `verifying`: Themis runs `.themis/verify.sh <task>` in the worktree. `1` back to running
   with the log; `2` blocked.
3. `reviewing`: Themis commits the worktree (`themis: <task> iteration <n>`), then the
   reviewer (read-only tools, tier `models.reviewer`) receives the task, the decisions and
   `git diff <base>..HEAD`, and returns `approve` or `changes` with reasons. `changes` goes
   back to `running` with the reasons in the prompt and consumes an iteration.
4. `merging`: in the main tree, `git merge --no-ff themis/<task>`. A conflict aborts the
   merge (`git merge --abort`) and consumes the iteration; the next one syncs the worktree with
   the working branch, which leaves the conflict there for the worker to resolve. After a clean
   merge Themis runs the full verifier in the main tree; if it fails, Themis undoes its own
   merge commit (`git reset --hard ORIG_HEAD`, only ever right after its own merge) and the
   task returns to `running` with the log. Then the worktree is removed and the task is done.

### Parallelism

- `themis run` without a task runs the whole graph: every task whose dependencies are done
  starts, up to `limits.parallel` at once, until nothing is runnable. Merges are serialised.
- `themis run <task>` runs that task only.
- Exit code: `0` all done, `1` some task failed, `2` some task blocked.

### Resume

State is written after every transition. On restart, tasks in `running`, `verifying`,
`reviewing` or `merging` resume from their worktree (kept on interrupt); a task whose branch
is already merged into the working branch is marked done. Ctrl-C stops the process; child
processes die with it.

### Minor decisions

Choices recorded by a task's worker are passed to later workers as settled decisions, so the
same question is not answered differently by different tasks.

## Consequences

- Themis creates branches `themis/<task>` and merge commits on the working branch: that is the
  product. It never force-pushes, never rewrites commits other than its own just-made merge.
- Parallel tasks adding dependencies may conflict on `package-lock.json`; such a task fails
  with the conflict and can be re-run on top of the merged result.

## Amendments from real runs (2026-10-06)

- Every iteration first syncs the task worktree with the working branch (`git merge`, pending
  work committed first). A conflict is left in place and the worker is told to resolve it;
  the iteration commit completes the merge. Without this, a task started before a sibling
  merged was verified against the sibling's criteria without having its code, and the
  reviewer rightly rejected the worker's attempts to re-implement it: a deadlock.
- Merge conflicts on the working branch no longer fail the task (see step 4).
- The verifier receives the task's criterion plus the done criteria whose branch is merged in
  the checkout being verified (ADR 0007, amended).
- `.themis/state.json` is written atomically (temporary file and rename).
