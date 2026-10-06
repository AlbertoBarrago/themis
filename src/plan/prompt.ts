import { ENGLISH_RULE, QUESTION_RULES } from "../agents/questions.js";
import { rejectionSection } from "../agents/structured.js";
import { SETUP_TASK } from "./schema.js";

/**
 * The planner's user prompt. Role behaviour lives in `.themis/agents/planner.md`; this prompt
 * carries the spec and the machine-checked rules, so a customised role file cannot silently
 * drop them.
 */
export function plannerPrompt(
  specPath: string,
  specSource: string,
  rejected: readonly string[],
): string {
  const parts = [
    `Plan the implementation of the Themis spec below (${specPath}).`,
    "",
    "<spec>",
    specSource.trimEnd(),
    "</spec>",
    "",
    "Return the task graph as structured output. Rules, checked mechanically:",
    "- Exactly one task per acceptance criterion, with the criterion's id (AC-<n>) as task id.",
    `- At most one extra task with id "${SETUP_TASK}", only if the decisions require project wiring, infrastructure or migrations that no criterion owns. It has no dependencies.`,
    "- dependsOn must keep every dependency the spec declares with Depends:.",
    `- You may add "${SETUP_TASK}" as a dependency of any task. You may add criterion dependencies only to criteria that have no Depends: line.`,
    "- Every dependency you add (not declared in the spec) must appear in addedDependencies with a one-sentence reason.",
    "- No dependency cycles.",
    "- scope: one short paragraph describing what the task delivers, in terms of the decisions; never restate the clauses.",
    ...QUESTION_RULES,
    ENGLISH_RULE,
  ];
  parts.push(...rejectionSection(rejected));
  return `${parts.join("\n")}\n`;
}
