import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readState as readTestsState } from "../acceptance/acceptance.js";
import type { TestsFile } from "../acceptance/schema.js";
import type { AgentRunner, AgentUsage } from "../adapters/agent-runner.js";
import { toAgentJsonSchema } from "../agents/questions.js";
import { readIfExists } from "../fs/generated.js";
import { Git } from "../git/git.js";
import { loadSpec, readTasks, zodErrors } from "../plan/plan.js";
import { type PlannedTask, SETUP_TASK, type TasksFile } from "../plan/schema.js";
import { ExecError, type Executor } from "../runtime/executor.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import type { Spec } from "../spec/types.js";
import { LOCK_PATH, protectedPaths, VERIFY_SCRIPT } from "../stack/node-ts/contract.js";
import { reviewerPrompt, type SettledChoice, type TaskContext, workerPrompt } from "./prompt.js";
import {
  describeLast,
  emptyTaskState,
  IN_PROGRESS,
  type IterationRecord,
  readState,
  type StateFile,
  type TaskState,
  type TaskStatus,
  writeState,
} from "./state.js";

export const WORKER_INSTRUCTIONS = ".themis/agents/worker.md";
export const REVIEWER_INSTRUCTIONS = ".themis/agents/reviewer.md";
export const WORKTREES_DIR = ".themis/worktrees";
const VERIFY_LOG = ".verify.log";
const WORKER_TIMEOUT_MS = 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

const workerOutput = z.strictObject({
  summary: z.string(),
  choices: z.array(z.strictObject({ question: z.string(), decision: z.string() })),
});
const reviewOutput = z.strictObject({
  verdict: z.enum(["approve", "changes"]),
  reasons: z.array(z.string()),
});
const workerOutputJsonSchema = toAgentJsonSchema(workerOutput);
const reviewOutputJsonSchema = toAgentJsonSchema(reviewOutput);

export type RunOutcome =
  | { kind: "not-initialized"; message: string }
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "not-ready"; message: string }
  | { kind: "git-not-ready"; message: string; commands: string[] }
  | { kind: "unknown-task"; task: string }
  | { kind: "dependencies-not-done"; task: string; missing: string[] }
  | { kind: "already-done"; task: string }
  /** `ran` lists the tasks this invocation worked on; `tasks` is the state of every task. */
  | { kind: "finished"; ran: string[]; tasks: Record<string, TaskState> };

/** Progress events, so the CLI can report each step while a long run is in progress. */
export type RunEvent =
  | { type: "task-start"; task: string; resumed: boolean }
  | { type: "iteration-start"; task: string; iteration: number; max: number }
  | {
      type: "worker-done";
      task: string;
      iteration: number;
      ok: boolean;
      error?: string;
      durationMs: number;
      costUsd: number | null;
    }
  | {
      type: "verify-done";
      task: string;
      iteration: number;
      exit: number | null;
      failedStep: string | null;
    }
  | {
      type: "review-done";
      task: string;
      iteration: number;
      verdict: "approve" | "changes";
      reasons: string[];
      costUsd: number | null;
    }
  | { type: "merged"; task: string }
  | { type: "merge-reverted"; task: string; failedStep: string | null }
  | { type: "merge-conflict"; task: string; conflicts: string[] }
  | { type: "task-end"; task: string; status: TaskStatus; reason: string | null };

export interface RunOptions {
  root: string;
  specPath: string;
  /** Run only this task; otherwise run the whole graph. */
  task?: string;
  runner: AgentRunner;
  /** Where agents, git, npm and the verifier run. */
  executor: Executor;
  onEvent?: (event: RunEvent) => void;
  now?: () => Date;
}

/**
 * `themis run` (ADR 0014): runs tasks in their own git worktrees, up to `limits.parallel` at
 * once, through `running -> verifying -> reviewing -> merging -> done`.
 *
 * Nothing an agent says is trusted: Themis runs the verifier itself, a separate reviewer
 * judges the diff, and after merging Themis verifies the working branch again, undoing its own
 * merge if the combination fails. State is persisted after every transition.
 */
export async function run(options: RunOptions): Promise<RunOutcome> {
  const { root, specPath, executor } = options;

  const workerInstructions = await readIfExists(join(root, WORKER_INSTRUCTIONS));
  const reviewerInstructions = await readIfExists(join(root, REVIEWER_INSTRUCTIONS));
  if (workerInstructions === undefined || reviewerInstructions === undefined) {
    return {
      kind: "not-initialized",
      message: `${WORKER_INSTRUCTIONS} or ${REVIEWER_INSTRUCTIONS} not found; run themis init first`,
    };
  }
  const loaded = await loadSpec(root, specPath);
  if (!loaded.ok) return loaded.outcome;

  const tasks = await readTasks(root);
  if (tasks?.status !== "approved")
    return {
      kind: "not-ready",
      message: "the plan is not approved (themis plan, themis approve plan)",
    };
  if (tasks.specDigest !== loaded.digest)
    return { kind: "not-ready", message: "the spec changed since the plan was approved; re-plan" };
  const testsState = await readTestsState(root);
  if (
    testsState?.status !== "approved" ||
    (await readIfExists(join(root, LOCK_PATH))) === undefined
  ) {
    return {
      kind: "not-ready",
      message: "the contract is not locked (themis tests, themis approve tests)",
    };
  }

  const git = new Git(executor);
  const gitProblem = await checkGit(git, root);
  if (typeof gitProblem !== "string") return gitProblem;
  const branch = gitProblem;

  const state = await readState(root);
  const statusOf = (id: string): TaskStatus => state.tasks[id]?.status ?? "pending";

  let only: PlannedTask | undefined;
  if (options.task !== undefined) {
    only = tasks.tasks.find((t) => t.id === options.task);
    if (only === undefined) return { kind: "unknown-task", task: options.task };
    if (statusOf(only.id) === "done") return { kind: "already-done", task: only.id };
    const missing = only.dependsOn.filter((d) => statusOf(d) !== "done");
    if (missing.length > 0) return { kind: "dependencies-not-done", task: only.id, missing };
  }

  const orchestrator = new Orchestrator({
    ...options,
    now: options.now ?? (() => new Date()),
    spec: loaded.spec,
    tasks,
    testsState,
    state,
    git,
    branch,
    workerInstructions,
    reviewerInstructions,
  });
  const ran = await orchestrator.schedule(only);
  return { kind: "finished", ran, tasks: state.tasks };
}

/** Returns the working branch, or why the repository is not ready. */
async function checkGit(
  git: Git,
  root: string,
): Promise<string | Extract<RunOutcome, { kind: "git-not-ready" }>> {
  const top = await git.topLevel(root);
  if (top === undefined) {
    return {
      kind: "git-not-ready",
      message: "themis run needs a git repository",
      commands: ["git init", "git add -A", 'git commit -m "themis contract"'],
    };
  }
  const branch = await git.currentBranch(root);
  if (branch === undefined) {
    return {
      kind: "git-not-ready",
      message: "themis run needs a branch with at least one commit (not a detached HEAD)",
      commands: ["git add -A", 'git commit -m "themis contract"'],
    };
  }
  const dirty = await git.dirtyPaths(root);
  if (dirty.length > 0) {
    return {
      kind: "git-not-ready",
      message: `the working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}); Themis merges into it and never commits your changes`,
      commands: ["git add -A", 'git commit -m "themis contract"'],
    };
  }
  if (!(await git.isTracked(root, LOCK_PATH))) {
    return {
      kind: "git-not-ready",
      message: "the locked contract is not committed",
      commands: [`git add -A`, 'git commit -m "themis contract"'],
    };
  }
  return branch;
}

interface OrchestratorOptions extends RunOptions {
  now: () => Date;
  spec: Spec;
  tasks: TasksFile;
  testsState: TestsFile;
  state: StateFile;
  git: Git;
  branch: string;
  workerInstructions: string;
  reviewerInstructions: string;
}

type Stage = "running" | "verifying" | "reviewing" | "merging";

class Orchestrator {
  readonly #o: OrchestratorOptions;
  readonly #emit: (event: RunEvent) => void;
  #saving: Promise<void> = Promise.resolve();
  #main: Promise<unknown> = Promise.resolve();

  constructor(options: OrchestratorOptions) {
    this.#o = options;
    this.#emit = options.onEvent ?? (() => {});
  }

  #status(id: string): TaskStatus {
    return this.#o.state.tasks[id]?.status ?? "pending";
  }

  /** Serialised state writes: parallel tasks share one state file. */
  #save(): Promise<void> {
    this.#saving = this.#saving.then(() => writeState(this.#o.root, this.#o.state));
    return this.#saving;
  }

  /** Serialises operations on the main working tree (worktree add/remove, merge, verify). */
  #withMain<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#main.then(fn, fn);
    this.#main = result.catch(() => undefined);
    return result;
  }

  async schedule(only: PlannedTask | undefined): Promise<string[]> {
    if (only !== undefined) {
      await this.#runTask(only);
      return [only.id];
    }
    const ran: string[] = [];
    const active = new Map<string, Promise<void>>();
    const limit = this.#o.spec.frontmatter.limits.parallel;
    const runnable = () =>
      this.#o.tasks.tasks
        .filter((t) => !active.has(t.id) && !ran.includes(t.id))
        .filter((t) => !["done", "failed", "blocked"].includes(this.#status(t.id)))
        .filter((t) => t.dependsOn.every((d) => this.#status(d) === "done"))
        // Interrupted tasks first, then plan order.
        .sort(
          (a, b) =>
            Number(IN_PROGRESS.includes(this.#status(b.id))) -
            Number(IN_PROGRESS.includes(this.#status(a.id))),
        );

    for (;;) {
      for (const task of runnable()) {
        if (active.size >= limit) break;
        ran.push(task.id);
        active.set(
          task.id,
          this.#runTask(task).finally(() => active.delete(task.id)),
        );
      }
      if (active.size === 0) return ran;
      await Promise.race(active.values());
    }
  }

  async #runTask(task: PlannedTask): Promise<void> {
    const { root, git, branch } = this.#o;
    const previous = this.#o.state.tasks[task.id] ?? emptyTaskState();
    const resumed = IN_PROGRESS.includes(previous.status);
    const ts: TaskState = {
      ...previous,
      reason: null,
      attemptStart: resumed ? previous.attemptStart : previous.iterations.length,
    };
    this.#o.state.tasks[task.id] = ts;
    let stage: Stage = resumed && previous.status !== "running" ? "verifying" : "running";
    const taskBranch = `themis/${task.id}`;
    const worktree = join(root, WORKTREES_DIR, task.id);
    this.#emit({ type: "task-start", task: task.id, resumed });

    if (
      resumed &&
      previous.status === "merging" &&
      (await git.branchExists(root, taskBranch)) &&
      (await git.isMerged(root, taskBranch, branch))
    ) {
      await this.#withMain(() => this.#removeWorktree(worktree));
      return this.#end(task.id, ts, "done", null);
    }

    ts.status = stage;
    await this.#save();
    if ((await readIfExists(join(worktree, ".git"))) === undefined) {
      await this.#withMain(() => git.addWorktree(root, worktree, taskBranch, branch));
      stage = "running";
    }
    if ((await readIfExists(join(worktree, "node_modules/.package-lock.json"))) === undefined) {
      const install = await this.#npmInstall(worktree);
      if (install !== undefined) return this.#end(task.id, ts, "blocked", install);
    }

    const context: TaskContext = {
      specPath: this.#o.specPath,
      task,
      criterion:
        task.id === SETUP_TASK ? undefined : this.#o.spec.criteria.find((c) => c.id === task.id),
      decisions: this.#o.spec.decisions,
      context: this.#o.spec.context,
    };
    const max = this.#o.spec.frontmatter.limits.max_iterations;
    let verifyLog = resumed ? await readIfExists(join(worktree, VERIFY_LOG)) : undefined;
    let reviewReasons: string[] = resumed
      ? (previous.iterations.at(-1)?.review?.reasons ?? [])
      : [];

    while (ts.iterations.length - ts.attemptStart < max) {
      const iteration = ts.iterations.length - ts.attemptStart + 1;
      const ordinal = ts.iterations.length + 1;
      const startedAt = this.#o.now();
      const record: IterationRecord = {
        iteration: ordinal,
        startedAt: startedAt.toISOString(),
        worker: null,
        verifyExit: null,
        failedStep: null,
      };
      this.#emit({ type: "iteration-start", task: task.id, iteration, max });

      let conflicts: string[] = [];
      if (stage === "running") {
        ts.status = "running";
        await this.#save();
        // Start from the latest working branch: code of tasks merged meanwhile is then present,
        // and the verifier only checks criteria actually merged into this branch.
        const sync = await git.syncWith(worktree, branch, `themis: sync ${task.id} with ${branch}`);
        if (sync.kind === "conflict") conflicts = sync.conflicts;
        const result = await this.#o.runner.run({
          role: "worker",
          tier: this.#o.spec.frontmatter.models.worker,
          cwd: worktree,
          instructions: this.#o.workerInstructions,
          prompt: workerPrompt({
            ...context,
            minorQuestions: [...this.#o.tasks.questions, ...this.#o.testsState.questions].filter(
              (q) => q.severity === "minor",
            ),
            settled: this.#settledChoices(task.id),
            verifyCommand: [VERIFY_SCRIPT, ...(await this.#criteriaFor(task.id, worktree))].join(
              " ",
            ),
            conflicts,
            branch,
            iteration,
            maxIterations: max,
            verifyLog,
            reviewReasons,
          }),
          tools: "edit",
          protectedPaths: protectedPaths(this.#o.specPath),
          outputSchema: workerOutputJsonSchema,
          timeoutMs: WORKER_TIMEOUT_MS,
        });
        record.worker = {
          ok: result.ok,
          durationMs: result.durationMs,
          costUsd: result.usage?.costUsd ?? null,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          ...(result.ok ? {} : { error: result.error }),
        };
        this.#emit({
          type: "worker-done",
          task: task.id,
          iteration,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error }),
          durationMs: result.durationMs,
          costUsd: record.worker.costUsd,
        });
        await this.#log(task.id, ordinal, "worker", { iteration, result });
        if (result.ok) {
          const parsed = workerOutput.safeParse(result.structured);
          if (parsed.success) ts.choices.push(...parsed.data.choices);
        } else if (result.kind === "unavailable") {
          ts.iterations.push(record);
          return this.#end(task.id, ts, "blocked", `agent unavailable: ${result.error}`);
        }
      }

      // Commit the iteration (completing a sync merge, if any), then verify in the worktree.
      // Themis runs the verifier; the worker's claims do not count.
      ts.status = "verifying";
      await this.#save();
      await git.commitAll(worktree, `themis: ${task.id} iteration ${ordinal}`);
      const verify = await this.#verify(worktree, await this.#criteriaFor(task.id, worktree));
      verifyLog = await readIfExists(join(worktree, VERIFY_LOG));
      record.verifyExit = verify.exit;
      record.failedStep = verify.exit === 0 ? null : failedStepOf(verifyLog);
      this.#emit({
        type: "verify-done",
        task: task.id,
        iteration,
        exit: verify.exit,
        failedStep: record.failedStep,
      });
      if (verify.exit === 1) {
        ts.iterations.push(record);
        stage = "running";
        reviewReasons = [];
        continue;
      }
      if (verify.exit !== 0) {
        ts.iterations.push(record);
        return this.#end(
          task.id,
          ts,
          "blocked",
          verify.reason ??
            `verifier exited ${verify.exit} at ${record.failedStep ?? "unknown step"}`,
        );
      }

      // Review the committed diff.
      ts.status = "reviewing";
      await this.#save();
      const diff = await git.diffSince(worktree, branch);
      const review = await this.#o.runner.run({
        role: "reviewer",
        tier: this.#o.spec.frontmatter.models.reviewer,
        cwd: worktree,
        instructions: this.#o.reviewerInstructions,
        prompt: reviewerPrompt(context, diff),
        tools: "read-only",
        protectedPaths: protectedPaths(this.#o.specPath),
        outputSchema: reviewOutputJsonSchema,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      await this.#log(task.id, ordinal, "review", { iteration, result: review });
      if (!review.ok) {
        ts.iterations.push(record);
        return this.#end(
          task.id,
          ts,
          "blocked",
          `reviewer ${review.kind === "unavailable" ? "unavailable" : "failed"}: ${review.error}`,
        );
      }
      const verdict = reviewOutput.safeParse(review.structured);
      if (!verdict.success) {
        ts.iterations.push(record);
        return this.#end(
          task.id,
          ts,
          "blocked",
          `reviewer returned an invalid verdict: ${zodErrors(verdict.error).join("; ")}`,
        );
      }
      record.review = {
        ...verdict.data,
        durationMs: review.durationMs,
        costUsd: costOf(review.usage),
      };
      this.#emit({
        type: "review-done",
        task: task.id,
        iteration,
        verdict: verdict.data.verdict,
        reasons: verdict.data.reasons,
        costUsd: record.review.costUsd,
      });
      if (verdict.data.verdict === "changes") {
        ts.iterations.push(record);
        stage = "running";
        reviewReasons = verdict.data.reasons;
        verifyLog = undefined;
        continue;
      }

      // Merge into the working branch, then verify the combination there.
      ts.status = "merging";
      await this.#save();
      const merge = await this.#withMain(() => this.#mergeAndVerify(taskBranch, task.id, worktree));
      if (merge.kind === "conflict") {
        // The merge was aborted, so the working branch is untouched. The next iteration syncs
        // the worktree with it, which reproduces the conflict there for the worker to resolve.
        record.mergeConflicts = merge.conflicts;
        ts.iterations.push(record);
        this.#emit({ type: "merge-conflict", task: task.id, conflicts: merge.conflicts });
        verifyLog = undefined;
        reviewReasons = [];
        stage = "running";
        continue;
      }
      if (merge.kind === "blocked") {
        ts.iterations.push(record);
        return this.#end(task.id, ts, "blocked", merge.reason);
      }
      if (merge.kind === "reverted") {
        record.mergeReverted = true;
        ts.iterations.push(record);
        this.#emit({ type: "merge-reverted", task: task.id, failedStep: failedStepOf(merge.log) });
        verifyLog = merge.log;
        reviewReasons = [];
        stage = "running";
        continue;
      }
      ts.iterations.push(record);
      this.#emit({ type: "merged", task: task.id });
      return this.#end(task.id, ts, "done", null);
    }
    return this.#end(
      task.id,
      ts,
      "failed",
      `not done after ${max} iterations (last: ${describeLast(ts.iterations.at(-1))})`,
    );
  }

  /** Under the main-tree lock: merge, refresh dependencies if needed, verify, undo on failure. */
  async #mergeAndVerify(
    taskBranch: string,
    task: string,
    worktree: string,
  ): Promise<
    | { kind: "merged" }
    | { kind: "conflict"; conflicts: string[] }
    | { kind: "reverted"; log: string | undefined }
    | { kind: "blocked"; reason: string }
  > {
    const { root, git } = this.#o;
    const merged = await git.merge(root, taskBranch, `themis: merge ${task}`);
    if (!merged.ok) return { kind: "conflict", conflicts: merged.conflicts };

    const changed = await git.changedFiles(root, "ORIG_HEAD");
    if (changed.some((f) => DEPENDENCY_FILES.includes(f))) {
      const install = await this.#npmInstall(root);
      if (install !== undefined) {
        await git.undoLastMerge(root);
        return { kind: "blocked", reason: install };
      }
    }
    const verify = await this.#verify(root, await this.#criteriaFor(task, root));
    if (verify.exit === 0) {
      await this.#removeWorktree(worktree);
      return { kind: "merged" };
    }
    const log = await readIfExists(join(root, VERIFY_LOG));
    await git.undoLastMerge(root);
    if (verify.exit === 1) return { kind: "reverted", log };
    return {
      kind: "blocked",
      reason:
        verify.reason ?? `the verifier exited ${verify.exit} on ${this.#o.branch} after merging`,
    };
  }

  async #removeWorktree(worktree: string): Promise<void> {
    if ((await readIfExists(join(worktree, ".git"))) !== undefined)
      await this.#o.git.removeWorktree(this.#o.root, worktree);
  }

  /** Decisions on minor questions taken by other tasks, latest first per question. */
  #settledChoices(current: string): SettledChoice[] {
    const settled = new Map<string, SettledChoice>();
    for (const [task, ts] of Object.entries(this.#o.state.tasks)) {
      if (task === current) continue;
      for (const c of ts.choices)
        settled.set(c.question, { task, question: c.question, decision: c.decision });
    }
    return [...settled.values()];
  }

  /**
   * Verifier arguments for `task` in the checkout at `cwd`: its own criterion plus every done
   * criterion whose branch is merged into that checkout, never criteria whose code is not
   * there (ADR 0007, amended). `none` when that set is empty.
   */
  async #criteriaFor(task: string, cwd: string): Promise<string[]> {
    const ids: string[] = [];
    for (const t of this.#o.tasks.tasks) {
      if (t.id === SETUP_TASK) continue;
      if (t.id === task) {
        ids.unshift(t.id);
      } else if (
        this.#status(t.id) === "done" &&
        (await this.#o.git.isMerged(cwd, `themis/${t.id}`, "HEAD"))
      ) {
        ids.push(t.id);
      }
    }
    return ids.length > 0 ? ids : ["none"];
  }

  async #verify(
    cwd: string,
    criteria: string[],
  ): Promise<{ exit: number | null; reason?: string }> {
    try {
      const result = await this.#o.executor.exec({
        command: VERIFY_SCRIPT,
        args: criteria,
        cwd,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      if (result.timedOut) return { exit: null, reason: "the verifier timed out" };
      return { exit: result.exitCode };
    } catch (err) {
      if (err instanceof ExecError)
        return { exit: null, reason: `the verifier could not run: ${err.message}` };
      throw err;
    }
  }

  /** Returns why installation failed, or `undefined` on success. */
  async #npmInstall(cwd: string): Promise<string | undefined> {
    try {
      const result = await this.#o.executor.exec({
        command: "npm",
        args: ["install", "--no-audit", "--no-fund"],
        cwd,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (result.exitCode === 0) return undefined;
      return `npm install failed in ${cwd}: ${(result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n")}`;
    } catch (err) {
      if (err instanceof ExecError) return `npm install could not run: ${err.message}`;
      throw err;
    }
  }

  async #end(
    task: string,
    ts: TaskState,
    status: "done" | "failed" | "blocked",
    reason: string | null,
  ): Promise<void> {
    ts.status = status;
    ts.reason = reason;
    await this.#save();
    this.#emit({ type: "task-end", task, status, reason });
  }

  async #log(
    task: string,
    ordinal: number,
    kind: string,
    entry: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(this.#o.root, ".themis/runs", task);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `iteration-${ordinal}-${kind}.json`),
      `${JSON.stringify({ task, ordinal, ...entry }, null, 2)}\n`,
    );
  }
}

function failedStepOf(log: string | undefined): string | null {
  return /^step: (.+)$/m.exec(log ?? "")?.[1] ?? null;
}

function costOf(usage: AgentUsage | null): number | null {
  return usage?.costUsd ?? null;
}
