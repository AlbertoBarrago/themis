import { z } from "zod";
import { toAgentJsonSchema } from "../agents/questions.js";

/** Roles whose instructions a retrospective may change: never `retro` itself (ADR 0015). */
export const RETRO_TARGETS = ["planner", "test-author", "worker", "reviewer"] as const;
export type RetroTarget = (typeof RETRO_TARGETS)[number];

export function instructionsPath(role: RetroTarget | "retro"): string {
  return `.themis/agents/${role}.md`;
}

/** The pending proposal; under `.themis/runs/` so it is git-ignored. */
export const RETRO_PATH = ".themis/runs/retro.json";

const edit = z.strictObject({ old: z.string(), new: z.string() });
export type InstructionEdit = z.infer<typeof edit>;

const proposal = z.strictObject({
  role: z.enum(RETRO_TARGETS),
  /** The recurring pattern this change addresses. */
  pattern: z.string().min(1),
  /** Evidence ids the pattern is based on. */
  evidence: z.array(z.string()).min(1),
  edits: z.array(edit).min(1),
});
export type Proposal = z.infer<typeof proposal>;

/** What the retro agent must return. An empty list means nothing worth changing. */
export const retroOutput = z.strictObject({ proposals: z.array(proposal) });
export type RetroOutput = z.infer<typeof retroOutput>;

export const retroOutputJsonSchema = toAgentJsonSchema(retroOutput);

/** `.themis/runs/retro.json`, see ADR 0015. */
export const retroFile = z.strictObject({
  themis: z.literal("0.1"),
  createdAt: z.string(),
  /** sha256 of every target file when the proposal was made. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  proposals: z.array(proposal),
});
export type RetroFile = z.infer<typeof retroFile>;
