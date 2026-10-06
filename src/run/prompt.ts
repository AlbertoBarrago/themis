import { ENGLISH_RULE } from "../agents/questions.js";
import type { PlannedTask, Question } from "../plan/schema.js";
import type { AcceptanceCriterion, Item } from "../spec/types.js";

export interface SettledChoice {
  task: string;
  question: string;
  decision: string;
}

export interface TaskContext {
  specPath: string;
  task: PlannedTask;
  /** The criterion behind the task; absent for the `setup` task. */
  criterion: AcceptanceCriterion | undefined;
  decisions: readonly Item[];
  /** Spec sections that are neither decisions nor criteria (e.g. a test harness section). */
  context: ReadonlyArray<{ heading: string; body: string }>;
}

export interface WorkerContext extends TaskContext {
  /** Exact verifier command for this task: its criterion plus the criteria already done. */
  verifyCommand: string;
  minorQuestions: readonly Question[];
  /** Minor questions other tasks already decided: constraints, not open questions. */
  settled: readonly SettledChoice[];
  iteration: number;
  maxIterations: number;
  /** `.verify.log` from the previous iteration, if verification failed. */
  verifyLog: string | undefined;
  /** Reviewer reasons from the previous iteration, if it asked for changes. */
  reviewReasons: readonly string[];
  /** Files left in conflict by merging the working branch into this task's branch. */
  conflicts: readonly string[];
  /** The working branch the task will be merged into. */
  branch: string;
}

function taskSection(ctx: TaskContext): string[] {
  const { task, criterion } = ctx;
  const parts = ["<task>", `${task.id}: ${task.title}`, task.scope];
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
  return parts;
}

/**
 * The worker's user prompt: deliberately minimal context (its task, the decisions, the last
 * verifier log or review), as the bootstrap requires. Role rules live in
 * `.themis/agents/worker.md`; the scope rule is repeated here because the first real run
 * showed the role file alone did not stop a worker from implementing other criteria.
 */
export function workerPrompt(ctx: WorkerContext): string {
  const parts = [
    `Implement task ${ctx.task.id} of the Themis spec ${ctx.specPath}. Iteration ${ctx.iteration} of ${ctx.maxIterations}.`,
    "",
    ...taskSection(ctx),
  ];
  if (ctx.settled.length > 0) {
    parts.push(
      "",
      "Questions other tasks already decided. Treat these as fixed decisions:",
      ...ctx.settled.map((s) => `- ${s.question} -> ${s.decision} (decided in ${s.task})`),
    );
  }
  if (ctx.minorQuestions.length > 0) {
    parts.push(
      "",
      "Open minor questions. Unless one is already decided above, decide it only if your task touches it, stay consistent with the decisions, and report the choice in `choices`:",
      ...ctx.minorQuestions.map((q) => `- ${q.text}`),
    );
  }
  parts.push(
    "",
    "Scope and judgement:",
    `- Implement only what task ${ctx.task.id} requires. Do not implement other criteria, even when their tests are visible or easy to satisfy: other workers own them, and a reviewer rejects out-of-scope changes.`,
    `- Run \`${ctx.verifyCommand}\` yourself as often as you like (it checks your criterion and those already done). Exit 0 means done; 1 means your code is wrong (read .verify.log); 2 means the environment is broken: stop and say so in your summary.`,
    "- After you finish, Themis runs the verifier itself and a reviewer reads your diff; only their verdicts count.",
    "- The acceptance tests under tests/acceptance/ are the contract. Read them; never change them, the verifier, the spec or the tool configuration.",
    "- Install the dependencies the decisions name with npm when you need them. Do not commit: Themis does.",
    ENGLISH_RULE,
  );
  if (ctx.conflicts.length > 0) {
    parts.push(
      "",
      `Themis merged ${ctx.branch} (with the work of tasks already done) into your branch and git stopped with conflicts in: ${ctx.conflicts.join(", ")}. Resolve them first: remove every conflict marker and keep the intent of both sides.`,
    );
  }
  if (ctx.reviewReasons.length > 0) {
    parts.push(
      "",
      "The reviewer asked for changes to your previous iteration:",
      ...ctx.reviewReasons.map((r) => `- ${r}`),
    );
  }
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

const MAX_DIFF_CHARS = 200_000;

/** The reviewer's user prompt: the task, the decisions and the diff it must judge. */
export function reviewerPrompt(ctx: TaskContext, diff: string): string {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const parts = [
    `Review the change made for task ${ctx.task.id} of the Themis spec ${ctx.specPath}. It already passes the verifier.`,
    "",
    ...taskSection(ctx),
    "",
    `<diff${truncated ? ' truncated="true"' : ""}>`,
    truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff,
    "</diff>",
    "",
    "Answer `approve`, or `changes` with concrete, actionable reasons. Ask for changes when:",
    `- the change implements behaviour that belongs to other criteria rather than ${ctx.task.id} (scope creep), including code paths no test of this task needs;`,
    "- it contradicts a decision or a public interface the decisions define;",
    "- it fakes the behaviour (hard-coded answers, test detection) instead of implementing it;",
    "- it swallows errors or leaves dead code.",
    "Do not ask for changes for style preferences. An empty diff is acceptable when an earlier task already delivered the behaviour.",
    "Code delivered by tasks already merged is part of the base, not of this diff: using it is fine.",
    "Open minor questions in the spec are the worker's to decide: a reasonable decision on one is not a reason to ask for changes.",
    ENGLISH_RULE,
  ];
  return `${parts.join("\n")}\n`;
}
