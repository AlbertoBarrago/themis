import { ENGLISH_RULE } from "../agents/questions.js";
import type { PlannedTask, Question } from "../plan/schema.js";
import type { AcceptanceCriterion, Item } from "../spec/types.js";

export interface WorkerContext {
  specPath: string;
  task: PlannedTask;
  /** The criterion behind the task; absent for the `setup` task. */
  criterion: AcceptanceCriterion | undefined;
  decisions: readonly Item[];
  /** Spec sections that are neither decisions nor criteria (e.g. a test harness section). */
  context: ReadonlyArray<{ heading: string; body: string }>;
  minorQuestions: readonly Question[];
  iteration: number;
  maxIterations: number;
  /** `.verify.log` from the previous iteration, if it failed. */
  verifyLog: string | undefined;
}

/**
 * The worker's user prompt: deliberately minimal context (its task, the decisions, the last
 * verifier log), as the bootstrap requires. Role rules live in `.themis/agents/worker.md`.
 */
export function workerPrompt(ctx: WorkerContext): string {
  const { task, criterion } = ctx;
  const parts = [
    `Implement task ${task.id} of the Themis spec ${ctx.specPath}. Iteration ${ctx.iteration} of ${ctx.maxIterations}.`,
    "",
    "<task>",
    `${task.id}: ${task.title}`,
    task.scope,
  ];
  if (criterion !== undefined) {
    parts.push(
      "",
      `Acceptance criterion ${criterion.id}: ${criterion.title}`,
      ...criterion.clauses.map((c) => `- ${c.text}`),
    );
    if (criterion.description !== "") parts.push("", criterion.description);
  }
  parts.push(
    "</task>",
    "",
    "<decisions>",
    ...ctx.decisions.map((d) => `- ${d.text}`),
    "</decisions>",
  );
  for (const section of ctx.context) {
    parts.push("", `<context heading="${section.heading}">`, section.body, "</context>");
  }
  if (ctx.minorQuestions.length > 0) {
    parts.push(
      "",
      "Open minor questions. When your task touches one, decide it, stay consistent with the decisions, and report the choice in `choices`:",
      ...ctx.minorQuestions.map((q) => `- ${q.text}`),
    );
  }
  parts.push(
    "",
    "How you are judged:",
    `- Run \`.themis/verify.sh ${task.id}\` yourself as often as you like. Exit 0 means done; 1 means your code is wrong (read .verify.log); 2 means the environment is broken: stop and say so in your summary.`,
    "- After you finish, Themis runs the verifier itself; only its result counts.",
    "- The acceptance tests under tests/acceptance/ are the contract. Read them; never change them, the verifier, the spec or the tool configuration.",
    "- Install the dependencies the decisions name with npm when you need them.",
    ENGLISH_RULE,
  );
  if (ctx.verifyLog !== undefined) {
    parts.push(
      "",
      "The verifier failed after the previous iteration. Its log:",
      "<verify-log>",
      ctx.verifyLog.trimEnd(),
      "</verify-log>",
    );
  }
  return `${parts.join("\n")}\n`;
}
