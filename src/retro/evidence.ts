import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound, readIfExists } from "../fs/generated.js";
import type { PlannedTask } from "../plan/schema.js";
import type { StateFile } from "../run/state.js";

/** One observation from a run, citable by id in a retrospective proposal (ADR 0015). */
export interface Evidence {
  id: string;
  task: string;
  detail: string;
}

export interface EvidenceSet {
  items: Evidence[];
  /** Run logs that exist but could not be read. */
  warnings: string[];
}

/**
 * Extracts the evidence of a run from the state and the worker logs, in plan order.
 * Deterministic: the agent receives this digest instead of reading raw logs.
 */
export async function collectEvidence(
  root: string,
  tasks: readonly PlannedTask[],
  state: StateFile,
): Promise<EvidenceSet> {
  const items: Evidence[] = [];
  const warnings: string[] = [];
  for (const { id: task } of tasks) {
    const ts = state.tasks[task];
    if (ts === undefined) continue;
    const add = (suffix: string, detail: string) =>
      items.push({ id: `${task}${suffix}`, task, detail });
    const denials = await permissionDenials(root, task, warnings);

    for (const record of ts.iterations) {
      const n = record.iteration;
      if (record.worker !== null && !record.worker.ok)
        add(`#${n}:worker`, `worker call failed: ${record.worker.error ?? "unknown error"}`);
      const denied = denials.get(n) ?? 0;
      if (denied > 0)
        add(
          `#${n}:denied`,
          `${denied} tool ${denied === 1 ? "call" : "calls"} refused by the protections`,
        );
      if (record.verifyExit !== null && record.verifyExit !== 0)
        add(
          `#${n}:verify`,
          `verifier exited ${record.verifyExit} at step ${record.failedStep ?? "unknown"}`,
        );
      if (record.review?.verdict === "changes")
        add(`#${n}:review`, `reviewer asked for changes: ${record.review.reasons.join(" | ")}`);
      if (record.mergeConflicts !== undefined)
        add(`#${n}:conflict`, `merge conflict on ${record.mergeConflicts.join(", ")}`);
      if (record.mergeReverted)
        add(`#${n}:reverted`, "the merged result failed the full verifier and was undone");
    }
    if (ts.status === "failed" || ts.status === "blocked")
      add(`:${ts.status}`, `task ${ts.status}: ${ts.reason ?? "no reason recorded"}`);
    ts.choices.forEach((c, i) => {
      add(`:choice-${i + 1}`, `worker decided "${c.question}": ${c.decision}`);
    });
  }
  return { items, warnings };
}

/** Permission denials per iteration, from `.themis/runs/<task>/iteration-<n>-worker.json`. */
async function permissionDenials(
  root: string,
  task: string,
  warnings: string[],
): Promise<Map<number, number>> {
  const dir = join(root, ".themis/runs", task);
  const denials = new Map<number, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return denials;
    throw err;
  }
  for (const name of names) {
    const n = /^iteration-(\d+)-worker\.json$/.exec(name)?.[1];
    if (n === undefined) continue;
    const path = `.themis/runs/${task}/${name}`;
    const source = await readIfExists(join(root, path));
    if (source === undefined) continue;
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch {
      warnings.push(`${path} is not valid JSON; skipped`);
      continue;
    }
    const count =
      typeof data === "object" && data !== null && "result" in data
        ? (data.result as { permissionDenials?: unknown } | null)?.permissionDenials
        : undefined;
    if (typeof count === "number") denials.set(Number(n), count);
  }
  return denials;
}
