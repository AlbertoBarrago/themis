import { z } from "zod";

export const SETUP_TASK = "setup";
const TASK_ID = /^(setup|AC-[1-9]\d*)$/;

const addedDependency = z.strictObject({
  id: z.string(),
  reason: z.string().min(1),
});

const plannedTask = z.strictObject({
  id: z.string().regex(TASK_ID),
  title: z.string().min(1),
  scope: z.string().min(1),
  dependsOn: z.array(z.string()),
  addedDependencies: z.array(addedDependency),
});

/** What the planner agent must return. Its JSON Schema is sent with the call. */
export const plannerOutput = z.strictObject({
  tasks: z.array(plannedTask).min(1),
  questions: z.array(z.string()),
});
export type PlannerOutput = z.infer<typeof plannerOutput>;
export type PlannedTask = z.infer<typeof plannedTask>;

/**
 * JSON Schema sent with the planner call. The `$schema` key is dropped: zod declares draft
 * 2020-12, which `claude --json-schema` rejects ("no schema with key or ref"), observed with
 * Claude Code 2.1.290.
 */
export const plannerOutputJsonSchema: Record<string, unknown> = (() => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(plannerOutput) as Record<string, unknown>;
  return schema;
})();

/** `.ordito/tasks.json`, see ADR 0010. */
export const tasksFile = z.strictObject({
  ordito: z.literal("0.1"),
  spec: z.string(),
  specDigest: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["draft", "approved"]),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  tasks: z.array(plannedTask),
  questions: z.array(z.string()),
});
export type TasksFile = z.infer<typeof tasksFile>;

export const TASKS_PATH = ".ordito/tasks.json";
