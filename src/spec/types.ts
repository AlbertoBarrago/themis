export const FORMAT_VERSION = "0.1";

export const STACKS = ["node-ts"] as const;
export type Stack = (typeof STACKS)[number];

export const VERIFY_STEPS = [
  "typecheck",
  "lint",
  "unit",
  "infra",
  "migrate",
  "acceptance",
] as const;
export type VerifyStep = (typeof VERIFY_STEPS)[number];

export const MODEL_TIERS = ["strong", "fast"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const AGENT_ROLES = ["planner", "worker", "reviewer", "retro"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface Limits {
  max_iterations: number;
  parallel: number;
}

/** Inclusive bounds of each limit (SPEC_FORMAT.md, section 3.4). */
export const LIMIT_BOUNDS: Record<keyof Limits, { min: number; max: number }> = {
  max_iterations: { min: 1, max: 50 },
  parallel: { min: 1, max: 16 },
};

export type Models = Record<AgentRole, ModelTier>;

/** Frontmatter with defaults applied. */
export interface Frontmatter {
  themis: typeof FORMAT_VERSION;
  stack: Stack;
  verify: VerifyStep[];
  limits: Limits;
  models: Models;
  /** `x-*` extension keys, passed through untouched. */
  extensions: Record<string, unknown>;
}

/** A list item with the line it starts on, so later stages can point back at the spec. */
export interface Item {
  text: string;
  line: number;
}

export type AcceptanceCriterionId = `AC-${number}`;

export interface AcceptanceCriterion {
  id: AcceptanceCriterionId;
  title: string;
  /** Line of the `## AC-<n>` heading. */
  line: number;
  /**
   * `null` when the spec has no `Depends:` line (dependencies left to the planner),
   * `[]` for `Depends: none`.
   */
  depends: AcceptanceCriterionId[] | null;
  clauses: Item[];
  /** Free text in the section that is neither `Depends:` nor a clause. */
  description: string;
}

/** Any level-2 section that is neither Decisions nor an acceptance criterion. */
export interface ContextSection {
  heading: string;
  line: number;
  body: string;
}

export interface Spec {
  frontmatter: Frontmatter;
  title: string;
  decisions: Item[];
  criteria: AcceptanceCriterion[];
  context: ContextSection[];
}
