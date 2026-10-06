import { ExecError, type Executor } from "../../runtime/executor.js";
import type { ModelTier } from "../../spec/types.js";
import {
  type AgentInvocation,
  type AgentResult,
  type AgentRunner,
  type AgentUsage,
  NO_USAGE,
  type ToolAccess,
} from "../agent-runner.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_MODELS: Record<ModelTier, string> = { strong: "opus", fast: "sonnet" };

const TOOLS: Record<ToolAccess, string> = {
  none: "",
  "read-only": "Read,Grep,Glob",
  edit: "Read,Edit,Write,Bash,Grep,Glob",
};

export interface ClaudeCodeRunnerOptions {
  executor: Executor;
  /** Environment used to resolve model overrides; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Executable name or path; defaults to `claude`. */
  command?: string;
}

/**
 * Inline `--settings` deny rule. Inline settings have no file to anchor `/` to (observed:
 * `Edit(/x)` is not enforced, ADR 0009), so rules are relative to the agent's cwd with `./`,
 * which also keeps them correct inside worktrees.
 */
export function inlineDenyRule(path: string): string {
  return `Edit(./${path.replace(/^(\.\/|\/)+/, "")})`;
}

/** Runs agents with `claude -p`. Every flag used here was verified in ADR 0009. */
export class ClaudeCodeRunner implements AgentRunner {
  readonly agent = "claude-code";
  readonly #executor: Executor;
  readonly #env: NodeJS.ProcessEnv;
  readonly #command: string;

  constructor(options: ClaudeCodeRunnerOptions) {
    this.#executor = options.executor;
    this.#env = options.env ?? process.env;
    this.#command = options.command ?? "claude";
  }

  /** Concrete model for a tier, honouring `THEMIS_CLAUDE_MODEL_<TIER>`. */
  model(tier: ModelTier): string {
    const override = this.#env[`THEMIS_CLAUDE_MODEL_${tier.toUpperCase()}`];
    return override !== undefined && override !== "" ? override : DEFAULT_MODELS[tier];
  }

  args(invocation: AgentInvocation): string[] {
    const settings = {
      permissions: { deny: invocation.protectedPaths.map(inlineDenyRule) },
    };
    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      this.model(invocation.tier),
      "--append-system-prompt",
      invocation.instructions,
      "--settings",
      JSON.stringify(settings),
      // Only project and local settings: user-level settings and the user's global CLAUDE.md
      // (personal instructions such as "wait for confirmation") must not reach agents. ADR 0013.
      "--setting-sources",
      "project,local",
      "--tools",
      TOOLS[invocation.tools],
      // Nothing may block on an interactive approval in a non-interactive run.
      "--permission-prompts",
      "none",
    ];
    if (invocation.tools === "edit") {
      // Verified (ADR 0013): file edits and shell commands are allowed, while the deny rules
      // above still stop Edit/Write and recognised Bash writes (`>`, `cp`) on protected paths.
      args.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash");
    }
    if (invocation.outputSchema !== undefined) {
      args.push("--json-schema", JSON.stringify(invocation.outputSchema));
    }
    if (invocation.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(invocation.maxBudgetUsd));
    }
    return args;
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    let result: Awaited<ReturnType<Executor["exec"]>>;
    try {
      result = await this.#executor.exec({
        command: this.#command,
        args: this.args(invocation),
        cwd: invocation.cwd,
        stdin: invocation.prompt,
        timeoutMs: invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof ExecError) {
        return {
          ok: false,
          kind: "unavailable",
          error:
            err.kind === "not-found"
              ? `${this.#command} is not installed or not on PATH`
              : err.message,
          usage: null,
          durationMs: 0,
        };
      }
      throw err;
    }

    if (result.timedOut) {
      return {
        ok: false,
        kind: "failed",
        error: `${this.#command} timed out`,
        usage: null,
        durationMs: result.durationMs,
      };
    }

    const parsed = parseOutput(result.stdout);
    if (parsed === undefined) {
      const detail = (result.stderr.trim() || result.stdout.trim())
        .split("\n")
        .slice(-5)
        .join("\n");
      return {
        ok: false,
        kind: result.exitCode === 0 ? "failed" : "unavailable",
        error: `${this.#command} exited with ${result.exitCode ?? result.signal} without a JSON result${detail === "" ? "" : `: ${detail}`}`,
        usage: null,
        durationMs: result.durationMs,
      };
    }

    const usage = parseUsage(parsed);
    // `subtype` stays "success" on API errors; `is_error` and the exit code are authoritative.
    if (parsed.is_error === true || result.exitCode !== 0) {
      return {
        ok: false,
        kind: "failed",
        error: typeof parsed.result === "string" ? parsed.result : "agent reported an error",
        usage,
        durationMs: result.durationMs,
      };
    }
    if (invocation.outputSchema !== undefined && parsed.structured_output === undefined) {
      return {
        ok: false,
        kind: "failed",
        error: "agent returned no structured output",
        usage,
        durationMs: result.durationMs,
      };
    }
    return {
      ok: true,
      text: typeof parsed.result === "string" ? parsed.result : "",
      structured: parsed.structured_output,
      usage,
      durationMs: result.durationMs,
      permissionDenials: Array.isArray(parsed.permission_denials)
        ? parsed.permission_denials.length
        : 0,
    };
  }
}

type Json = Record<string, unknown>;

function parseOutput(stdout: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isObject(value) && value.type === "result" ? value : undefined;
  } catch {
    // Not JSON at all: reported by the caller with stderr as context.
    return undefined;
  }
}

function parseUsage(output: Json): AgentUsage {
  const usage = isObject(output.usage) ? output.usage : {};
  return {
    ...NO_USAGE,
    inputTokens: numberOr0(usage.input_tokens),
    outputTokens: numberOr0(usage.output_tokens),
    cacheReadTokens: numberOr0(usage.cache_read_input_tokens),
    cacheCreationTokens: numberOr0(usage.cache_creation_input_tokens),
    costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : null,
  };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
