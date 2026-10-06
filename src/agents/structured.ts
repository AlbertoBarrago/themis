import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInvocation, AgentRunner, AgentUsage } from "../adapters/agent-runner.js";

export const MAX_ATTEMPTS = 3;

export interface Totals {
  attempts: number;
  durationMs: number;
  costUsd: number | null;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type StructuredOutcome<T> =
  | { kind: "ok"; value: T; totals: Totals }
  | { kind: "unavailable" | "failed"; message: string; totals: Totals }
  | { kind: "invalid"; errors: string[]; totals: Totals };

export interface StructuredCall<T> {
  runner: AgentRunner;
  /** Builds the invocation; `rejected` holds the reasons the previous answer was refused. */
  invocation: (rejected: readonly string[]) => AgentInvocation;
  /** Parses and validates the structured output. Agent output is never trusted as is. */
  validate: (structured: unknown) => Validation<T>;
  /** Project root; each attempt is logged under `.themis/runs/<logDir>/`. */
  root: string;
  logDir: string;
  now: () => Date;
  maxAttempts?: number;
}

/**
 * Calls an agent for structured output and validates it, sending the validation errors back
 * on the next attempt. An agent that cannot run stops immediately: retrying would not help.
 */
export async function callStructured<T>(call: StructuredCall<T>): Promise<StructuredOutcome<T>> {
  const totals: Totals = { attempts: 0, durationMs: 0, costUsd: null };
  const maxAttempts = call.maxAttempts ?? MAX_ATTEMPTS;
  let rejected: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = call.now();
    const invocation = call.invocation(rejected);
    const result = await call.runner.run(invocation);
    totals.attempts = attempt;
    totals.durationMs += result.durationMs;
    totals.costUsd = addCost(totals.costUsd, result.usage);

    if (!result.ok) {
      await logAttempt(call, invocation, startedAt, attempt, {
        ok: false,
        kind: result.kind,
        error: result.error,
        usage: result.usage,
        durationMs: result.durationMs,
      });
      return { kind: result.kind, message: result.error, totals };
    }

    const validation = call.validate(result.structured);
    await logAttempt(call, invocation, startedAt, attempt, {
      ok: validation.ok,
      structured: result.structured,
      errors: validation.ok ? [] : validation.errors,
      usage: result.usage,
      durationMs: result.durationMs,
      permissionDenials: result.permissionDenials,
    });
    if (validation.ok) return { kind: "ok", value: validation.value, totals };
    rejected = validation.errors;
  }
  return { kind: "invalid", errors: rejected, totals };
}

/** Prompt section listing the reasons the previous answer was rejected. */
export function rejectionSection(rejected: readonly string[]): string[] {
  if (rejected.length === 0) return [];
  return [
    "",
    "Your previous answer was rejected for these reasons. Fix all of them:",
    ...rejected.map((r) => `- ${r}`),
  ];
}

export function formatTotals(label: string, totals: Totals): string {
  const cost = totals.costUsd === null ? "" : `, $${totals.costUsd.toFixed(4)}`;
  const attempts = `${totals.attempts} ${totals.attempts === 1 ? "attempt" : "attempts"}`;
  return `${label}: ${attempts}, ${(totals.durationMs / 1000).toFixed(1)}s${cost}\n`;
}

function addCost(total: number | null, usage: AgentUsage | null): number | null {
  if (usage?.costUsd === null || usage?.costUsd === undefined) return total;
  return (total ?? 0) + usage.costUsd;
}

async function logAttempt<T>(
  call: StructuredCall<T>,
  invocation: AgentInvocation,
  startedAt: Date,
  attempt: number,
  entry: Record<string, unknown>,
): Promise<void> {
  const dir = join(call.root, ".themis/runs", call.logDir);
  await mkdir(dir, { recursive: true });
  const stamp = startedAt.toISOString().replaceAll(":", "-");
  await writeFile(
    join(dir, `${stamp}-${attempt}.json`),
    `${JSON.stringify({ role: invocation.role, tier: invocation.tier, attempt, startedAt: startedAt.toISOString(), ...entry }, null, 2)}\n`,
  );
}
