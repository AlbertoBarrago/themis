import { FORMAT_VERSION, type Limits, type VerifyStep } from "./types.js";

/** What `themis new` asks for; everything else in the skeleton is a placeholder to fill in. */
export interface SpecDraft {
  title: string;
  /** One paragraph under the title; empty for a placeholder. */
  summary: string;
  verify: VerifyStep[];
  limits: Limits;
  /** Criteria in order; the n-th one becomes `AC-<n>`. Empty for one placeholder criterion. */
  criteria: Array<{ title: string; dependsOn: string[] }>;
}

export const DEFAULT_VERIFY: VerifyStep[] = ["typecheck", "lint", "unit", "acceptance"];
export const DEFAULT_LIMITS: Limits = { max_iterations: 3, parallel: 2 };

/**
 * Renders a draft as a spec that passes `themis check`. The placeholders are written as
 * `<...>` so they stand out in review, and are valid Markdown text everywhere they appear.
 */
export function renderSpec(draft: SpecDraft): string {
  const criteria =
    draft.criteria.length > 0
      ? draft.criteria
      : [{ title: "<What the first criterion delivers>", dependsOn: [] }];
  const sections = criteria.map((c, i) =>
    [
      `## AC-${i + 1} ${c.title}`,
      `Depends: ${c.dependsOn.length === 0 ? "none" : c.dependsOn.join(", ")}`,
      "- Given <a starting state>",
      "- When <an action>",
      "- Then <an observable outcome>",
    ].join("\n"),
  );
  return [
    "---",
    `themis: ${FORMAT_VERSION}`,
    "stack: node-ts",
    `verify: [${draft.verify.join(", ")}]`,
    `limits: { max_iterations: ${draft.limits.max_iterations}, parallel: ${draft.limits.parallel} }`,
    "---",
    "",
    `# ${draft.title}`,
    "",
    draft.summary || "<One paragraph: what this is, and what it deliberately is not.>",
    "",
    "## Decisions",
    "",
    "- <The public interface the tests rely on: module paths and exported signatures, routes",
    "  and payloads, environment variables. Agents must respect decisions and never reopen them.>",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}
