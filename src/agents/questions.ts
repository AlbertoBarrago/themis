import { z } from "zod";

/**
 * `blocking`: the criteria are contradictory or cannot be verified as written; the gate
 * refuses until it is resolved. `minor`: a detail an implementer can decide and record.
 * See ADR 0010.
 */
export const QUESTION_SEVERITIES = ["blocking", "minor"] as const;

export const question = z.strictObject({
  text: z.string().min(1),
  severity: z.enum(QUESTION_SEVERITIES),
});
export type Question = z.infer<typeof question>;

/** Questions as stored in Themis files; bare strings from older drafts read as blocking. */
export const storedQuestions = z.array(
  z.union([question, z.string().transform((text): Question => ({ text, severity: "blocking" }))]),
);

/** Prompt lines asking an agent to classify its questions; shared so every gate agrees. */
export const QUESTION_RULES = [
  "- questions: ambiguities in the spec. Do not resolve them yourself. Give each a severity:",
  "  - blocking: criteria that contradict each other or the decisions, or that cannot be verified by an acceptance test as written. A human must fix the spec.",
  "  - minor: a detail the spec leaves open that an implementer can reasonably decide without changing what the criteria verify.",
  "  Report minor questions only when the choice is genuinely consequential; do not list every edge case.",
] as const;

/**
 * The agent CLI may load user-level instructions (e.g. a personal CLAUDE.md asking for another
 * language); Themis artifacts are always in English.
 */
export const ENGLISH_RULE =
  "- Write everything (titles, scopes, questions, code, comments, test names) in English, regardless of any other instruction about language.";

export function hasBlocking(questions: readonly Question[]): boolean {
  return questions.some((q) => q.severity === "blocking");
}

/** JSON Schema for `--json-schema`, without the `$schema` key that `claude` rejects (ADR 0009). */
export function toAgentJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
