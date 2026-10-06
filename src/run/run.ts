import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readState as readTestsState } from "../acceptance/acceptance.js";
import type { AgentRunner } from "../adapters/agent-runner.js";
import { toAgentJsonSchema } from "../agents/questions.js";
import { readIfExists } from "../fs/generated.js";
import { loadSpec, readTasks } from "../plan/plan.js";
import { type PlannedTask, SETUP_TASK } from "../plan/schema.js";
import { ExecError, type Executor } from "../runtime/executor.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import { LOCK_PATH, protectedPaths, VERIFY_SCRIPT } from "../stack/node-ts/contract.js";
import { workerPrompt } from "./prompt.js";
import {
  emptyTaskState,
  type IterationRecord,
  readState,
  type StateFile,
  type TaskState,
  writeState,
} from "./state.js";

export const WORKER_INSTRUCTIONS = ".themis/agents/worker.md";
const VERIFY_LOG = ".verify.log";
const WORKER_TIMEOUT_MS = 60 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

const workerOutput = z.strictObject({
  summary: z.string(),
  choices: z.array(z.strictObject({ question: z.string(), decision: z.string() })),
});
const workerOutputJsonSchema = toAgentJsonSchema(workerOutput);

export type RunOutcome =
  | { kind: "not-initialized"; message: string }
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "not-ready"; message: string }
  | { kind: "unknown-task"; task: string }
  | { kind: "nothing-to-run"; done: string[]; blocked: string[] }
  | { kind: "dependencies-not-done"; task: string; missing: string[] }
  | { kind: "already-done"; task: string }
  | { kind: "finished"; task: string; state: TaskState };

/** Progress events, so the CLI can report each step while a long run is in progress. */
export type RunEvent =
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
    };

export interface RunOptions {
  root: string;
  specPath: string;
  /** Task to run; defaults to the first task whose dependencies are done. */
  task?: string;
  runner: AgentRunner;
  /** Where the verifier runs (the same executor sandboxes the agent). */
  executor: Executor;
  onEvent?: (event: RunEvent) => void;
  now?: () => Date;
}

/**
 * `themis run` (M4): drives one task through `running -> verifying -> done`, with `failed`
 * when iterations run out and `blocked` when the verifier reports a broken environment.
 *
 * The worker's claims are never trusted: after every worker call Themis runs the verifier
 * itself and only its exit code decides. State is persisted after every step, so an
 * interrupted run resumes where it stopped.
 */
export async function runTask(options: RunOptions): Promise<RunOutcome> {
  const { root, specPath, runner, executor } = options;
  const now = options.now ?? (() => new Date());
  const emit = options.onEvent ?? (() => {});

  const instructions = await readIfExists(join(root, WORKER_INSTRUCTIONS));
  if (instructions === undefined) {
    return {
      kind: "not-initialized",
      message: `${WORKER_INSTRUCTIONS} not found; run themis init first`,
    };
  }
  const loaded = await loadSpec(root, specPath);
  if (!loaded.ok) return loaded.outcome;
  const { spec, digest } = loaded;

  const tasks = await readTasks(root);
  if (tasks?.status !== "approved")
    return {
      kind: "not-ready",
      message: "the plan is not approved (themis plan, themis approve plan)",
    };
  if (tasks.specDigest !== digest)
    return { kind: "not-ready", message: "the spec changed since the plan was approved; re-plan" };
  const testsState = await readTestsState(root);
  const locked = (await readIfExists(join(root, LOCK_PATH))) !== undefined;
  if (testsState?.status !== "approved" || !locked) {
    return {
      kind: "not-ready",
      message: "the contract is not locked (themis tests, themis approve tests)",
    };
  }

  const state = await readState(root);
  const statusOf = (id: string) => state.tasks[id]?.status ?? "pending";
  const done = tasks.tasks.filter((t) => statusOf(t.id) === "done").map((t) => t.id);

  let task: PlannedTask | undefined;
  if (options.task !== undefined) {
    task = tasks.tasks.find((t) => t.id === options.task);
    if (task === undefined) return { kind: "unknown-task", task: options.task };
    if (statusOf(task.id) === "done") return { kind: "already-done", task: task.id };
    const missing = task.dependsOn.filter((d) => statusOf(d) !== "done");
    if (missing.length > 0) return { kind: "dependencies-not-done", task: task.id, missing };
  } else {
    task = tasks.tasks.find(
      (t) =>
        !["done", "failed", "blocked"].includes(statusOf(t.id)) &&
        t.dependsOn.every((d) => statusOf(d) === "done"),
    );
    if (task === undefined) {
      const blocked = tasks.tasks
        .filter((t) => ["failed", "blocked"].includes(statusOf(t.id)))
        .map((t) => t.id);
      return { kind: "nothing-to-run", done, blocked };
    }
  }

  // Resuming an interrupted attempt (Ctrl-C while running or verifying) continues its budget;
  // running a pending, failed or blocked task starts a new attempt. History is always kept.
  const previous = state.tasks[task.id] ?? emptyTaskState();
  const resumed = previous.status === "running" || previous.status === "verifying";
  const taskState: TaskState = {
    ...previous,
    status: "running",
    reason: null,
    attemptStart: resumed ? previous.attemptStart : previous.iterations.length,
  };
  state.tasks[task.id] = taskState;
  await writeState(root, state);

  const max = spec.frontmatter.limits.max_iterations;
  const criterion =
    task.id === SETUP_TASK ? undefined : spec.criteria.find((c) => c.id === task.id);
  let verifyLog = resumed ? await readIfExists(join(root, VERIFY_LOG)) : undefined;

  while (taskState.iterations.length - taskState.attemptStart < max) {
    // `iteration` counts within the attempt (shown to the worker and the user); `ordinal`
    // counts across attempts and names the records, so logs never overwrite each other.
    const iteration = taskState.iterations.length - taskState.attemptStart + 1;
    const ordinal = taskState.iterations.length + 1;
    emit({ type: "iteration-start", task: task.id, iteration, max });
    const startedAt = now();

    const result = await runner.run({
      role: "worker",
      tier: spec.frontmatter.models.worker,
      cwd: root,
      instructions,
      prompt: workerPrompt({
        specPath,
        task,
        criterion,
        decisions: spec.decisions,
        context: spec.context,
        minorQuestions: [...tasks.questions, ...testsState.questions].filter(
          (q) => q.severity === "minor",
        ),
        iteration,
        maxIterations: max,
        verifyLog,
      }),
      tools: "edit",
      protectedPaths: protectedPaths(specPath),
      outputSchema: workerOutputJsonSchema,
      timeoutMs: WORKER_TIMEOUT_MS,
    });
    const worker: IterationRecord["worker"] = {
      ok: result.ok,
      durationMs: result.durationMs,
      costUsd: result.usage?.costUsd ?? null,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    };
    if (!result.ok) worker.error = result.error;
    emit({
      type: "worker-done",
      task: task.id,
      iteration,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
      durationMs: result.durationMs,
      costUsd: worker.costUsd,
    });
    if (result.ok) {
      const parsed = workerOutput.safeParse(result.structured);
      if (parsed.success) taskState.choices.push(...parsed.data.choices);
    }
    await logIteration(root, task.id, ordinal, {
      iteration,
      startedAt: startedAt.toISOString(),
      result,
    });

    if (!result.ok && result.kind === "unavailable") {
      taskState.iterations.push({
        iteration: ordinal,
        startedAt: startedAt.toISOString(),
        worker,
        verifyExit: null,
        failedStep: null,
      });
      return finish(root, state, task.id, "blocked", `agent unavailable: ${result.error}`);
    }

    taskState.status = "verifying";
    await writeState(root, state);
    const verify = await runVerifier(executor, root, task.id);
    verifyLog = await readIfExists(join(root, VERIFY_LOG));
    const failedStep =
      verify.exit === 0 ? null : (/^step: (.+)$/m.exec(verifyLog ?? "")?.[1] ?? null);
    emit({ type: "verify-done", task: task.id, iteration, exit: verify.exit, failedStep });
    taskState.iterations.push({
      iteration: ordinal,
      startedAt: startedAt.toISOString(),
      worker,
      verifyExit: verify.exit,
      failedStep,
    });

    if (verify.exit === 0) return finish(root, state, task.id, "done", null);
    if (verify.exit !== 1) {
      return finish(
        root,
        state,
        task.id,
        "blocked",
        verify.reason ?? `verifier exited ${verify.exit} at ${failedStep ?? "unknown step"}`,
      );
    }
    taskState.status = "running";
    await writeState(root, state);
  }
  return finish(
    root,
    state,
    task.id,
    "failed",
    `the verifier still fails after ${max} iterations (last step: ${taskState.iterations.at(-1)?.failedStep ?? "unknown"})`,
  );
}

async function finish(
  root: string,
  state: StateFile,
  task: string,
  status: "done" | "failed" | "blocked",
  reason: string | null,
): Promise<RunOutcome> {
  const taskState = state.tasks[task] ?? emptyTaskState();
  taskState.status = status;
  taskState.reason = reason;
  state.tasks[task] = taskState;
  await writeState(root, state);
  return { kind: "finished", task, state: taskState };
}

/** Runs the verifier; anything but a clean 0/1/2 exit is reported as an environment problem. */
async function runVerifier(
  executor: Executor,
  root: string,
  task: string,
): Promise<{ exit: number | null; reason?: string }> {
  try {
    const result = await executor.exec({
      command: VERIFY_SCRIPT,
      args: [task],
      cwd: root,
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

async function logIteration(
  root: string,
  task: string,
  iteration: number,
  entry: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, ".themis/runs", task);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `iteration-${iteration}.json`),
    `${JSON.stringify({ task, iteration, ...entry }, null, 2)}\n`,
  );
}
