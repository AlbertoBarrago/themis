import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initCommand } from "../../src/cli/commands/init.js";
import { sha256 } from "../../src/fs/digest.js";
import type { IterationRecord, StateFile } from "../../src/run/state.js";
import { lines } from "../helpers.js";
import { FakeExecutor } from "./executor.js";

export const HISTORY_SPEC = lines(
  "---",
  "themis: 0.1",
  "stack: node-ts",
  "verify: [typecheck, acceptance]",
  "limits: { max_iterations: 3 }",
  "---",
  "# S",
  "## Decisions",
  "- d",
  "## AC-1 One",
  "Depends: none",
  "- Then one",
  "## AC-2 Two",
  "Depends: none",
  "- Then two",
  "## AC-3 Three",
  "Depends: none",
  "- Then three",
);

const silent = { stdout: () => {}, stderr: () => {} };

export function iteration(n: number, extra: Partial<IterationRecord> = {}): IterationRecord {
  return {
    iteration: n,
    startedAt: "2026-10-06T10:00:00.000Z",
    worker: { ok: true, durationMs: 1000, costUsd: 0.1, inputTokens: 10, outputTokens: 5 },
    verifyExit: 0,
    failedStep: null,
    review: { verdict: "approve", reasons: [], durationMs: 500, costUsd: 0.05 },
    ...extra,
  };
}

/**
 * A run history: AC-1 done at its second iteration (typecheck failed first), AC-2 failed after
 * a requested change, a merge conflict and an undone merge, AC-3 never started.
 */
export const HISTORY: StateFile = {
  themis: "0.1",
  tasks: {
    "AC-1": {
      status: "done",
      iterations: [
        withoutReview(iteration(1, { verifyExit: 1, failedStep: "typecheck" })),
        iteration(2),
      ],
      attemptStart: 0,
      reason: null,
      choices: [{ question: "Which quote style?", decision: "double quotes" }],
    },
    "AC-2": {
      status: "failed",
      iterations: [
        iteration(1, {
          review: {
            verdict: "changes",
            reasons: ["implements AC-3 too", "adds an unused helper"],
            durationMs: 500,
            costUsd: 0.05,
          },
        }),
        iteration(2, { mergeConflicts: ["package-lock.json"] }),
        iteration(3, { mergeReverted: true }),
      ],
      attemptStart: 0,
      reason: "not done after 3 iterations (last: the merged result failed the verifier)",
      choices: [],
    },
  },
};

/** An iteration that stopped before review. */
export function withoutReview(record: IterationRecord): IterationRecord {
  const { review: _review, ...rest } = record;
  return rest;
}

/** Initialises `root` with the spec, an approved plan and the given state. */
export async function writeHistory(root: string, state: StateFile = HISTORY): Promise<void> {
  await writeFile(join(root, "spec.md"), HISTORY_SPEC);
  await initCommand(
    ["--skip-install"],
    { cwd: root, ...silent },
    new FakeExecutor({ git: () => ({ stdout: "true\n" }) }),
  );
  await mkdir(join(root, ".themis"), { recursive: true });
  await writeFile(
    join(root, ".themis/tasks.json"),
    JSON.stringify({
      themis: "0.1",
      spec: "spec.md",
      specDigest: sha256(HISTORY_SPEC),
      status: "approved",
      createdAt: "2026-10-06T09:00:00.000Z",
      approvedAt: "2026-10-06T09:01:00.000Z",
      tasks: ["AC-1", "AC-2", "AC-3"].map((id) => ({
        id,
        title: `Task ${id}`,
        scope: `Does ${id}.`,
        dependsOn: [],
        addedDependencies: [],
      })),
      questions: [],
    }),
  );
  await writeFile(join(root, ".themis/state.json"), JSON.stringify(state));
}
