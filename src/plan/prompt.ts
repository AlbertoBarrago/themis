import { SETUP_TASK } from "./schema.js";

/**
 * The planner's user prompt. Role behaviour lives in `.ordito/agents/planner.md`; this prompt
 * carries the spec and the machine-checked rules, so a customised role file cannot silently
 * drop them.
 */
export function plannerPrompt(specPath: string, specSource: string, rejected: string[]): string {
  const parts = [
    `Plan the implementation of the Ordito spec below (${specPath}).`,
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
    "- questions: ambiguities or contradictions in the spec that a human must resolve. Do not resolve them yourself.",
    // The agent CLI may load user-level instructions (e.g. a personal CLAUDE.md asking for
    // another language); Ordito artifacts are always in English.
    "- Write every title, scope and question in English, regardless of any other instruction about language.",
  ];
  if (rejected.length > 0) {
    parts.push(
      "",
      "Your previous answer was rejected for these reasons. Fix all of them:",
      ...rejected.map((r) => `- ${r}`),
    );
  }
  return `${parts.join("\n")}\n`;
}
