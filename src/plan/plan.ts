import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { AgentRunner } from "../adapters/agent-runner.js";
import { callStructured, type Totals } from "../agents/structured.js";
import { sha256 } from "../fs/digest.js";
import { isNotFound, readIfExists } from "../fs/generated.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import { parseSpec } from "../spec/parse.js";
import type { Spec } from "../spec/types.js";
import { protectedPaths } from "../stack/node-ts/contract.js";
import { plannerPrompt } from "./prompt.js";
import {
  plannerOutput,
  plannerOutputJsonSchema,
  TASKS_PATH,
  type TasksFile,
  tasksFile,
} from "./schema.js";
import { validatePlan } from "./validate.js";

export const PLANNER_INSTRUCTIONS = ".ordito/agents/planner.md";

export interface PlanOptions {
  root: string;
  specPath: string;
  force: boolean;
  runner: AgentRunner;
  now?: () => Date;
}

export type PlanTotals = Totals;

export type PlanOutcome =
  | { kind: "not-initialized"; message: string }
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "already-approved" }
  | { kind: "agent-unavailable"; message: string; totals: PlanTotals }
  | { kind: "agent-failed"; message: string; totals: PlanTotals }
  | { kind: "invalid-plan"; errors: string[]; totals: PlanTotals }
  | { kind: "done"; tasks: TasksFile; totals: PlanTotals };

/** Result of loading the spec, shared by `plan` and `approve plan`. */
export type LoadedSpec =
  | { ok: true; spec: Spec; source: string; digest: string }
  | { ok: false; outcome: Extract<PlanOutcome, { kind: "spec-unreadable" | "invalid-spec" }> };

export async function loadSpec(root: string, specPath: string): Promise<LoadedSpec> {
  let source: string;
  try {
    source = await readFile(join(root, specPath), "utf8");
  } catch (err) {
    return {
      ok: false,
      outcome: {
        kind: "spec-unreadable",
        message: isNotFound(err)
          ? `${specPath} not found`
          : `cannot read ${specPath}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const { spec, diagnostics } = parseSpec(source);
  if (spec === undefined) return { ok: false, outcome: { kind: "invalid-spec", diagnostics } };
  return { ok: true, spec, source, digest: sha256(source) };
}

/** A `.ordito/tasks.json` that exists but cannot be used; never silently replaced. */
export class TasksFileError extends Error {
  override readonly name = "TasksFileError";
}

/** Reads `.ordito/tasks.json`; `undefined` when absent, throws {@link TasksFileError} when invalid. */
export async function readTasks(root: string): Promise<TasksFile | undefined> {
  const source = await readIfExists(join(root, TASKS_PATH));
  if (source === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new TasksFileError(
      `${TASKS_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = tasksFile.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TasksFileError(
      `${TASKS_PATH} is invalid: ${issue === undefined ? "unknown error" : `${issue.path.join(".")}: ${issue.message}`}`,
    );
  }
  return parsed.data;
}

export async function writeTasks(root: string, tasks: TasksFile): Promise<void> {
  await writeFile(join(root, TASKS_PATH), `${JSON.stringify(tasks, null, 2)}\n`);
}

/**
 * `ordito plan`: asks the planner agent for a task graph, validates it against the spec and
 * writes a draft `.ordito/tasks.json` for the human gate. Rejected answers are sent back with
 * the reasons (see {@link callStructured}). Every call is logged under
 * `.ordito/runs/plan/`.
 */
export async function plan(options: PlanOptions): Promise<PlanOutcome> {
  const { root, specPath, runner } = options;
  const now = options.now ?? (() => new Date());

  const instructions = await readIfExists(join(root, PLANNER_INSTRUCTIONS));
  if (instructions === undefined) {
    return {
      kind: "not-initialized",
      message: `${PLANNER_INSTRUCTIONS} not found; run ordito init first`,
    };
  }
  const loaded = await loadSpec(root, specPath);
  if (!loaded.ok) return loaded.outcome;
  const { spec, source, digest } = loaded;

  const existing = await readTasks(root);
  if (existing?.status === "approved" && !options.force) return { kind: "already-approved" };

  const outcome = await callStructured({
    runner,
    root,
    logDir: "plan",
    now,
    invocation: (rejected) => ({
      role: "planner",
      tier: spec.frontmatter.models.planner,
      cwd: root,
      instructions,
      prompt: plannerPrompt(specPath, source, rejected),
      tools: "none",
      protectedPaths: protectedPaths(specPath),
      outputSchema: plannerOutputJsonSchema,
    }),
    validate: (structured) => {
      const parsed = plannerOutput.safeParse(structured);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const validation = validatePlan(spec, parsed.data);
      return validation.ok
        ? { ok: true, value: { tasks: validation.tasks, questions: parsed.data.questions } }
        : validation;
    },
  });

  switch (outcome.kind) {
    case "unavailable":
      return { kind: "agent-unavailable", message: outcome.message, totals: outcome.totals };
    case "failed":
      return { kind: "agent-failed", message: outcome.message, totals: outcome.totals };
    case "invalid":
      return { kind: "invalid-plan", errors: outcome.errors, totals: outcome.totals };
    case "ok": {
      const tasks: TasksFile = {
        ordito: "0.1",
        spec: specPath,
        specDigest: digest,
        status: "draft",
        createdAt: now().toISOString(),
        approvedAt: null,
        tasks: outcome.value.tasks,
        questions: outcome.value.questions,
      };
      await writeTasks(root, tasks);
      return { kind: "done", tasks, totals: outcome.totals };
    }
  }
}

/** Zod issues as `path: message` lines, the format agents receive when an answer is rejected. */
export function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`);
}

export type ApproveOutcome =
  | { kind: "no-plan" }
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "spec-changed" }
  | { kind: "blocked"; tasks: TasksFile }
  | { kind: "already-approved"; tasks: TasksFile }
  | { kind: "approved"; tasks: TasksFile };

export interface ApproveOptions {
  /** Approve despite blocking questions. */
  force?: boolean;
  now?: () => Date;
}

/**
 * `ordito approve plan`: the human gate. Refuses a plan made for a different spec, and one
 * with blocking questions unless forced: those mean the criteria cannot be turned into a
 * coherent contract as written.
 */
export async function approvePlan(
  root: string,
  options: ApproveOptions = {},
): Promise<ApproveOutcome> {
  const now = options.now ?? (() => new Date());
  const tasks = await readTasks(root);
  if (tasks === undefined) return { kind: "no-plan" };
  if (tasks.status === "approved") return { kind: "already-approved", tasks };

  const loaded = await loadSpec(root, tasks.spec);
  if (!loaded.ok) return loaded.outcome;
  if (loaded.digest !== tasks.specDigest) return { kind: "spec-changed" };
  if (!options.force && tasks.questions.some((q) => q.severity === "blocking")) {
    return { kind: "blocked", tasks };
  }

  const approved: TasksFile = { ...tasks, status: "approved", approvedAt: now().toISOString() };
  await writeTasks(root, approved);
  return { kind: "approved", tasks: approved };
}
