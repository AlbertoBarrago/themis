import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readState as readTestsState } from "../acceptance/acceptance.js";
import { lockFile } from "../acceptance/schema.js";
import { sha256 } from "../fs/digest.js";
import { isNotFound, readIfExists } from "../fs/generated.js";
import { loadSpec, readTasks, zodErrors } from "../plan/plan.js";
import { RETRO_PATH } from "../retro/schema.js";
import { describeLast, type IterationRecord, readState, type TaskStatus } from "../run/state.js";
import { LOCK_PATH } from "../stack/node-ts/contract.js";

export type SpecGate = { ok: true } | { ok: false; problem: string };
export type PlanGate = "absent" | "draft" | "approved" | "stale";
export type ContractGate =
  | { state: "absent" | "draft" | "locked" }
  /** Locked, but these files no longer match their digest (or are gone). */
  | { state: "modified"; files: string[] };

export interface TaskReport {
  id: string;
  title: string;
  status: TaskStatus;
  /** Iterations of the current attempt. */
  iterations: number;
  maxIterations: number | null;
  /** Iterations across every attempt. */
  totalIterations: number;
  costUsd: number | null;
  /** Why the task is failed or blocked, or what went wrong in its last iteration. */
  note: string | null;
}

export interface StatusReport {
  spec: { path: string } & SpecGate;
  plan: PlanGate;
  contract: ContractGate;
  tasks: TaskReport[];
  totals: { iterations: number; costUsd: number | null };
  retroPending: boolean;
}

/** A Themis file that exists but cannot be read; `status` then cannot report. */
export class LockFileError extends Error {
  override readonly name = "LockFileError";
}

/**
 * `themis status` (ADR 0015): a read-only report of the gates and of every planned task.
 * Throws the `*FileError` of whichever Themis file exists but is invalid.
 */
export async function status(root: string, specPath: string): Promise<StatusReport> {
  const loaded = await loadSpec(root, specPath);
  const spec: StatusReport["spec"] = loaded.ok
    ? { path: specPath, ok: true }
    : {
        path: specPath,
        ok: false,
        problem:
          loaded.outcome.kind === "spec-unreadable" ? loaded.outcome.message : "invalid spec",
      };

  const tasks = await readTasks(root);
  let plan: PlanGate = "absent";
  if (tasks !== undefined) {
    plan =
      tasks.status === "draft"
        ? "draft"
        : loaded.ok && tasks.specDigest !== loaded.digest
          ? "stale"
          : "approved";
  }

  const contract = await contractGate(root);
  const state = await readState(root);
  const max = loaded.ok ? loaded.spec.frontmatter.limits.max_iterations : null;

  const reports: TaskReport[] = (tasks?.tasks ?? []).map((task) => {
    const ts = state.tasks[task.id];
    const iterations = ts?.iterations ?? [];
    const status = ts?.status ?? "pending";
    return {
      id: task.id,
      title: task.title,
      status,
      iterations: iterations.length - (ts?.attemptStart ?? 0),
      maxIterations: max,
      totalIterations: iterations.length,
      costUsd: sumCosts(iterations.map(costOf)),
      note:
        ts?.reason ??
        (status === "done" || iterations.length === 0 ? null : describeLast(iterations.at(-1))),
    };
  });

  return {
    spec,
    plan,
    contract,
    tasks: reports,
    totals: {
      iterations: reports.reduce((n, t) => n + t.totalIterations, 0),
      costUsd: sumCosts(reports.map((t) => t.costUsd)),
    },
    retroPending: (await readIfExists(join(root, RETRO_PATH))) !== undefined,
  };
}

async function contractGate(root: string): Promise<ContractGate> {
  const source = await readIfExists(join(root, LOCK_PATH));
  if (source === undefined) {
    return { state: (await readTestsState(root)) === undefined ? "absent" : "draft" };
  }
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new LockFileError(
      `${LOCK_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = lockFile.safeParse(data);
  if (!parsed.success) {
    throw new LockFileError(`${LOCK_PATH} is invalid: ${zodErrors(parsed.error)[0] ?? "unknown"}`);
  }
  const modified: string[] = [];
  for (const [path, digest] of Object.entries(parsed.data.files)) {
    try {
      if (sha256(await readFile(join(root, path))) !== digest) modified.push(path);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      modified.push(path);
    }
  }
  return modified.length === 0 ? { state: "locked" } : { state: "modified", files: modified };
}

function costOf(record: IterationRecord): number | null {
  return sumCosts([record.worker?.costUsd ?? null, record.review?.costUsd ?? null]);
}

/** `null` when no cost is known at all, so an unknown cost never reads as free. */
function sumCosts(costs: ReadonlyArray<number | null>): number | null {
  const known = costs.filter((c): c is number => c !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}
