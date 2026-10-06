import { describe, expect, it } from "vitest";
import type { AgentInvocation } from "../../src/adapters/agent-runner.js";
import { ClaudeCodeRunner, inlineDenyRule } from "../../src/adapters/claude-code/runner.js";
import { ExecError, type ExecResult } from "../../src/runtime/executor.js";
import { FakeExecutor } from "../fakes/executor.js";

const invocation: AgentInvocation = {
  role: "planner",
  tier: "strong",
  cwd: "/project",
  instructions: "You plan.",
  prompt: "Plan this.",
  tools: "none",
  protectedPaths: ["tests/acceptance/**", "spec.md"],
};

/** Shape observed from `claude -p --output-format json` (ADR 0009). */
function claudeJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.0278,
    usage: {
      input_tokens: 10,
      output_tokens: 413,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 12886,
    },
    permission_denials: [{ tool_name: "Edit" }],
    ...overrides,
  });
}

function runnerReturning(result: Partial<ExecResult>) {
  const executor = new FakeExecutor({ claude: () => result });
  return { executor, runner: new ClaudeCodeRunner({ executor, env: {} }) };
}

describe("ClaudeCodeRunner arguments", () => {
  it("builds a non-interactive JSON call with per-invocation protections", async () => {
    const { executor, runner } = runnerReturning({ stdout: claudeJson() });
    await runner.run({ ...invocation, outputSchema: { type: "object" }, maxBudgetUsd: 2 });
    const request = executor.requests[0];
    expect(request?.command).toBe("claude");
    expect(request?.cwd).toBe("/project");
    expect(request?.stdin).toBe("Plan this.");
    expect(request?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "opus",
      "--append-system-prompt",
      "You plan.",
      "--settings",
      '{"permissions":{"deny":["Edit(./tests/acceptance/**)","Edit(./spec.md)"]}}',
      "--tools",
      "",
      "--permission-prompts",
      "none",
      "--json-schema",
      '{"type":"object"}',
      "--max-budget-usd",
      "2",
    ]);
  });

  it("maps tiers to models, with environment overrides", () => {
    const runner = new ClaudeCodeRunner({
      executor: new FakeExecutor(),
      env: { ORDITO_CLAUDE_MODEL_FAST: "haiku" },
    });
    expect(runner.model("strong")).toBe("opus");
    expect(runner.model("fast")).toBe("haiku");
  });

  it("anchors inline rules to the cwd", () => {
    expect(inlineDenyRule("spec.md")).toBe("Edit(./spec.md)");
    expect(inlineDenyRule("/spec.md")).toBe("Edit(./spec.md)");
    expect(inlineDenyRule("./.ordito/**")).toBe("Edit(./.ordito/**)");
  });

  it("grants read-only tools", () => {
    const runner = new ClaudeCodeRunner({ executor: new FakeExecutor() });
    const args = runner.args({ ...invocation, tools: "read-only" });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  });
});

describe("ClaudeCodeRunner results", () => {
  it("parses text, structured output, usage, cost and denials", async () => {
    const { runner } = runnerReturning({
      stdout: claudeJson({ structured_output: { answer: 4 } }),
      durationMs: 5000,
    });
    expect(await runner.run({ ...invocation, outputSchema: {} })).toEqual({
      ok: true,
      text: "done",
      structured: { answer: 4 },
      usage: {
        inputTokens: 10,
        outputTokens: 413,
        cacheReadTokens: 5,
        cacheCreationTokens: 12886,
        costUsd: 0.0278,
      },
      durationMs: 5000,
      permissionDenials: 1,
    });
  });

  it("treats is_error as failure even when subtype says success", async () => {
    const { runner } = runnerReturning({
      exitCode: 1,
      stdout: claudeJson({ is_error: true, result: "There's an issue with the selected model" }),
    });
    expect(await runner.run(invocation)).toMatchObject({
      ok: false,
      kind: "failed",
      error: "There's an issue with the selected model",
    });
  });

  it("reports a missing CLI as unavailable", async () => {
    const runner = new ClaudeCodeRunner({ executor: new FakeExecutor() });
    expect(await runner.run(invocation)).toMatchObject({
      ok: false,
      kind: "unavailable",
      error: "claude is not installed or not on PATH",
    });
  });

  it("reports a non-JSON failure as unavailable, with stderr", async () => {
    const { runner } = runnerReturning({ exitCode: 1, stdout: "", stderr: "Not logged in" });
    expect(await runner.run(invocation)).toMatchObject({
      ok: false,
      kind: "unavailable",
      error: expect.stringContaining("Not logged in"),
    });
  });

  it("reports a timeout", async () => {
    const { runner } = runnerReturning({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(await runner.run(invocation)).toMatchObject({
      ok: false,
      kind: "failed",
      error: "claude timed out",
    });
  });

  it("fails when a schema was requested but no structured output came back", async () => {
    const { runner } = runnerReturning({ stdout: claudeJson() });
    expect(await runner.run({ ...invocation, outputSchema: {} })).toMatchObject({
      ok: false,
      error: "agent returned no structured output",
    });
  });

  it("propagates unexpected executor errors", async () => {
    const executor = new FakeExecutor({ claude: () => new ExecError("spawn-failed", "claude") });
    const runner = new ClaudeCodeRunner({ executor });
    expect(await runner.run(invocation)).toMatchObject({ ok: false, kind: "unavailable" });
  });
});
