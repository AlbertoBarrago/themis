import { ENGLISH_RULE } from "../agents/questions.js";
import { rejectionSection } from "../agents/structured.js";
import type { Evidence } from "./evidence.js";

/**
 * The retro agent's user prompt: the evidence extracted by Themis and the instruction files it
 * may change. The machine-checked rules are restated here, so a customised `retro.md` cannot
 * drop them.
 */
export function retroPrompt(
  evidence: readonly Evidence[],
  instructions: ReadonlyMap<string, string>,
  rejected: readonly string[],
): string {
  const parts = [
    "Analyse this Themis run and propose improvements to the agents' instructions.",
    "",
    "<evidence>",
    ...evidence.map((e) => `- ${e.id}: ${e.detail}`),
    "</evidence>",
  ];
  for (const [path, content] of instructions) {
    parts.push("", `<file path="${path}">`, content.trimEnd(), "</file>");
  }
  parts.push(
    "",
    "Return your proposals as structured output. Rules, checked mechanically:",
    "- role: whose instructions to change: planner, test-author, worker or reviewer (the files above). Nothing else can be changed.",
    "- pattern: the recurring problem the change addresses, in one or two sentences.",
    "- evidence: the ids above that show the pattern. Propose a change only for a pattern you can cite; a single isolated incident is rarely a pattern.",
    "- edits: replacements applied in order; each old must be copied verbatim from the file as left by the previous edits and occur in it exactly once. To add text, replace a nearby line with that line plus the new text.",
    "- Never propose weakening the contract: no instruction to edit, skip or relax tests, the verifier, the guard or tool configuration.",
    "- Return an empty proposals list when nothing is worth changing.",
    ENGLISH_RULE,
  );
  parts.push(...rejectionSection(rejected));
  return `${parts.join("\n")}\n`;
}
