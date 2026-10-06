import { ENGLISH_RULE, QUESTION_RULES } from "../agents/questions.js";
import { rejectionSection } from "../agents/structured.js";
import type { TasksFile } from "../plan/schema.js";
import { ACCEPTANCE_DIR } from "../stack/node-ts/contract.js";

/**
 * The test author's user prompt: spec, approved plan and the mechanically checked rules.
 * The node-ts conventions here match the generated `vitest.config.ts` and `verify.sh`.
 */
export function testAuthorPrompt(
  specPath: string,
  specSource: string,
  tasks: TasksFile,
  rejected: readonly string[],
): string {
  const plan = tasks.tasks.map((t) => `- ${t.id} (${t.title}): ${t.scope}`).join("\n");
  const parts = [
    `Write the acceptance tests for the Ordito spec below (${specPath}).`,
    "",
    "<spec>",
    specSource.trimEnd(),
    "</spec>",
    "",
    "<approved-plan>",
    plan,
    "</approved-plan>",
    "",
    "Project conventions (node-ts stack):",
    `- Every file lives under ${ACCEPTANCE_DIR}/. Test files end in .test.ts; support code (harness, fixtures) may use other .ts names.`,
    `- ${ACCEPTANCE_DIR}/global-setup.ts, if you create it, is loaded by vitest as globalSetup (export default or setup/teardown functions).`,
    '- Test runner: vitest (import { describe, it, expect, beforeAll, afterAll } from "vitest"). Acceptance files run sequentially.',
    '- TypeScript strict, ESM, NodeNext resolution: relative imports use the .js extension ("../../src/app.js").',
    "- You may read the project with your tools, but you cannot write: return the files as structured output.",
    "",
    "Rules, checked mechanically:",
    '- Each criterion AC-<n> has a describe block named exactly "AC-<n>: <title>". Every criterion in the spec must have one; no other AC ids.',
    "- No .only(, .skip(, .todo(, @ts-ignore, @ts-nocheck, @ts-expect-error, `as any`, or linter suppression comments.",
    "- Paths: relative, under tests/acceptance/, letters, digits, '.', '_', '-' and '/' only.",
    ...QUESTION_RULES,
    ENGLISH_RULE,
  ];
  parts.push(...rejectionSection(rejected));
  return `${parts.join("\n")}\n`;
}
