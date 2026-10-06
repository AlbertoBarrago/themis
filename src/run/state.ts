import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../fs/generated.js";

export const STATE_PATH = ".themis/state.json";

export const TASK_STATUSES = [
  "pending",
  "running",
  "verifying",
  "reviewing",
  "merging",
  "done",
  "failed",
  "blocked",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses of a task interrupted mid-attempt, which resumes on the next run. */
export const IN_PROGRESS: readonly TaskStatus[] = ["running", "verifying", "reviewing", "merging"];

const iteration = z.strictObject({
  iteration: z.number().int().positive(),
  startedAt: z.string(),
  /** `null` when the iteration resumed after an interruption and skipped the worker call. */
  worker: z
    .strictObject({
      ok: z.boolean(),
      error: z.string().optional(),
      durationMs: z.number(),
      costUsd: z.number().nullable(),
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .nullable(),
  /** Verifier exit code; `null` when the verifier did not run or was killed. */
  verifyExit: z.number().int().nullable(),
  /** Step that failed, from `.verify.log`. */
  failedStep: z.string().nullable(),
  /** Reviewer verdict, when the iteration reached review. */
  review: z
    .strictObject({
      verdict: z.enum(["approve", "changes"]),
      reasons: z.array(z.string()),
      durationMs: z.number(),
      costUsd: z.number().nullable(),
    })
    .optional(),
  /** Set when the merged result failed the full verifier and Themis undid its merge. */
  mergeReverted: z.boolean().optional(),
  /** Paths that conflicted when merging into the working branch (the merge was aborted). */
  mergeConflicts: z.array(z.string()).optional(),
});
export type IterationRecord = z.infer<typeof iteration>;

const choice = z.strictObject({ question: z.string(), decision: z.string() });

const taskState = z.strictObject({
  status: z.enum(TASK_STATUSES),
  /** Every iteration ever run for this task, across attempts. */
  iterations: z.array(iteration),
  /**
   * Index in `iterations` where the current attempt started. Each attempt has a budget of
   * `limits.max_iterations`; re-running a failed or blocked task starts a new attempt, while
   * resuming an interrupted one continues its budget.
   */
  attemptStart: z.number().int().nonnegative(),
  /** Why a task is failed or blocked. */
  reason: z.string().nullable(),
  /** Minor questions the worker decided, collected for the retrospective. */
  choices: z.array(choice),
});
export type TaskState = z.infer<typeof taskState>;

/** `.themis/state.json`: persisted after every step so a run can be interrupted and resumed. */
export const stateFile = z.strictObject({
  themis: z.literal("0.1"),
  tasks: z.record(z.string(), taskState),
});
export type StateFile = z.infer<typeof stateFile>;

export class StateFileError extends Error {
  override readonly name = "StateFileError";
}

export function emptyTaskState(): TaskState {
  return { status: "pending", iterations: [], attemptStart: 0, reason: null, choices: [] };
}

export async function readState(root: string): Promise<StateFile> {
  const source = await readIfExists(join(root, STATE_PATH));
  if (source === undefined) return { themis: "0.1", tasks: {} };
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new StateFileError(
      `${STATE_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = stateFile.safeParse(data);
  if (!parsed.success) {
    throw new StateFileError(
      `${STATE_PATH} is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/**
 * Writes the state atomically (temporary file, then rename): an interruption mid-write must
 * never leave a truncated state file, since resuming depends on it.
 */
export async function writeState(root: string, state: StateFile): Promise<void> {
  const target = join(root, STATE_PATH);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, target);
}
