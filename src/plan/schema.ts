import { z } from "zod";
import { question, storedQuestions, toAgentJsonSchema } from "../agents/questions.js";

export type { Question } from "../agents/questions.js";

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
  questions: z.array(question),
});
export type PlannerOutput = z.infer<typeof plannerOutput>;
export type PlannedTask = z.infer<typeof plannedTask>;

/** JSON Schema sent with the planner call (see {@link toAgentJsonSchema}). */
export const plannerOutputJsonSchema = toAgentJsonSchema(plannerOutput);

/** `.themis/tasks.json`, see ADR 0010. */
export const tasksFile = z.strictObject({
  themis: z.literal("0.1"),
  spec: z.string(),
  specDigest: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["draft", "approved"]),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  tasks: z.array(plannedTask),
  questions: storedQuestions,
});
export type TasksFile = z.output<typeof tasksFile>;

export const TASKS_PATH = ".themis/tasks.json";
