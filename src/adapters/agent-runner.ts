import type { AgentRole, ModelTier } from "../spec/types.js";

/**
 * Tool access granted to an agent, in adapter-neutral terms. Each adapter maps these to its
 * own tool names. `edit` lets the agent change files and run shell commands, within the
 * per-invocation protections.
 */
export type ToolAccess = "none" | "read-only" | "edit";

/** Spec roles (which have a model tier in the frontmatter) plus internal roles. */
export type InvocationRole = AgentRole | "test-author";

export interface AgentInvocation {
  role: InvocationRole;
  tier: ModelTier;
  /** Project (or worktree) root the agent works in. */
  cwd: string;
  /** Role instructions, from `.themis/agents/<role>.md`. */
  instructions: string;
  prompt: string;
  tools: ToolAccess;
  /** Project-relative paths the agent must not write, enforced per invocation. */
  protectedPaths: readonly string[];
  /** JSON Schema the final answer must satisfy; the result then carries `structured`. */
  outputSchema?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `null` when the agent CLI does not report cost. */
  costUsd: number | null;
}

export type AgentResult =
  | {
      ok: true;
      text: string;
      /** Parsed structured output, present when `outputSchema` was given. */
      structured: unknown;
      usage: AgentUsage;
      durationMs: number;
      /** Tool calls refused by the protections: a signal for the retrospective. */
      permissionDenials: number;
    }
  | {
      ok: false;
      /**
       * `unavailable`: the agent CLI cannot run here (not installed, not authenticated):
       * an environment problem. `failed`: the call ran and errored or returned garbage.
       */
      kind: "unavailable" | "failed";
      error: string;
      usage: AgentUsage | null;
      durationMs: number;
    };

/** Runs one agent invocation. Implementations must execute through an `Executor`. */
export interface AgentRunner {
  readonly agent: string;
  run(invocation: AgentInvocation): Promise<AgentResult>;
}

export const NO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: null,
};
